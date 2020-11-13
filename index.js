'use strict';

const _ = require('lodash');
const parseColor = require('parse-color');
const colorDiff = require('color-diff');
const fs = require('fs-extra');
const png = require('./lib/png');
const areColorsSame = require('./lib/same-colors');
const AntialiasingComparator = require('./lib/antialiasing-comparator');
const IgnoreCaretComparator = require('./lib/ignore-caret-comparator');
const utils = require('./lib/utils');
const {getDiffPixelsCoords} = utils;
const {JND} = require('./lib/constants');

const makeAntialiasingComparator = (comparator, png1, png2, opts) => {
    const antialiasingComparator = new AntialiasingComparator(comparator, png1, png2, opts);
    return (data) => antialiasingComparator.compare(data);
};

const makeNoCaretColorComparator = (comparator, pixelRatio) => {
    const caretComparator = new IgnoreCaretComparator(comparator, pixelRatio);
    return (data) => caretComparator.compare(data);
};

function makeCIEDE2000Comparator(tolerance) {
    return function doColorsLookSame(data) {
        if (areColorsSame(data)) {
            return true;
        }
        /*jshint camelcase:false*/
        const lab1 = colorDiff.rgb_to_lab(data.color1);
        const lab2 = colorDiff.rgb_to_lab(data.color2);

        return colorDiff.diff(lab1, lab2) < tolerance;
    };
}

const createComparator = (png1, png2, opts) => {
    let comparator = opts.strict ? areColorsSame : makeCIEDE2000Comparator(opts.tolerance);

    if (opts.ignoreAntialiasing) {
        comparator = makeAntialiasingComparator(comparator, png1, png2, opts);
    }

    if (opts.ignoreCaret) {
        comparator = makeNoCaretColorComparator(comparator, opts.pixelRatio);
    }

    return comparator;
};

const iterateRect = (width, height, callback, endCallback) => {
    const processRow = (y) => {
        setImmediate(() => {
            for (let x = 0; x < width; x++) {
                callback(x, y);
            }

            y++;

            if (y < height) {
                processRow(y);
            } else {
                endCallback();
            }
        });
    };

    processRow(0);
};

const buildDiffImage = (png1, png2, options, callback) => {
    const width = Math.max(png1.width, png2.width);
    const height = Math.max(png1.height, png2.height);
    const minWidth = Math.min(png1.width, png2.width);
    const minHeight = Math.min(png1.height, png2.height);
    const highlightColor = options.highlightColor;
    const result = png.empty(width, height);

    iterateRect(width, height, (x, y) => {
        if (x >= minWidth || y >= minHeight) {
            result.setPixel(x, y, highlightColor);
            return;
        }

        const color1 = png1.getPixel(x, y);
        const color2 = png2.getPixel(x, y);

        if (!options.comparator({color1, color2, png1, png2, x, y, width, height})) {
            result.setPixel(x, y, highlightColor);
        } else {
            result.setPixel(x, y, color1);
        }
    }, () => callback(result));
};

const parseColorString = (str) => {
    const parsed = parseColor(str || '#ff00ff');

    return {
        R: parsed.rgb[0],
        G: parsed.rgb[1],
        B: parsed.rgb[2]
    };
};

const getToleranceFromOpts = (opts) => {
    if (!_.hasIn(opts, 'tolerance')) {
        return JND;
    }

    if (opts.strict) {
        throw new TypeError('Unable to use "strict" and "tolerance" options together');
    }

    return opts.tolerance;
};

const prepareOpts = (opts) => {
    opts = opts || {};
    opts.tolerance = getToleranceFromOpts(opts);

    return _.defaults(opts, {
        ignoreCaret: true,
        ignoreAntialiasing: true,
        antialiasingTolerance: 0
    });
};

const getMaxDiffBounds = (first, second) => {
    const {x: left, y: top} = first.getActualCoord(0, 0);

    return {
        left,
        top,
        right: left + Math.max(first.width, second.width) - 1,
        bottom: top + Math.max(first.height, second.height) - 1
    };
};

module.exports = exports = async function looksSame(image1, image2, opts, callback) {
    if (!callback) {
        callback = opts;
        opts = {};
    }

    opts = prepareOpts(opts);
    [image1, image2] = utils.formatImages(image1, image2);

    // console.log(`hermione:looks-same: ref src: ${image1.source}`);

    const readCb = async ({source, ...opts}) => {
        const buf = await fs.readFile(source);
        return {source: buf, ...opts};
    };

    // try {
    const start = process.hrtime();
    const {first: buffData1, second: buffData2} = await utils.readPair(image1, image2, readCb);
    const buffEquals = buffData1.source.equals(buffData2.source);
    const end1 = process.hrtime(start);

    console.log(`hermione:looks-same: ref src: ${image1.source}, actual src: ${image2.source}, buf1: ${buffData1.source.length}, buf2: ${buffData2.source.length}, exec_time: ${end1[0]}s ${end1[1] / 1e6}ms, BUFFERS ARE ${buffEquals ? 'EQUAL' : 'NOT EQUAL'}`);

    // if (buffEquals) {
    // process.nextTick(() => callback(null, {equal: true}));
    // }

    // else {
    // console.log(`hermione:looks-same: ref src: ${image1.source}, buf1: ${first.source.length}, buf2: ${second.source.length}, BUFFERS ARE NOT EQUAL`);
    // }
    // } catch (err) {
    // return callback(err);
    // }

    utils
        .readPair(buffData1, buffData2)
        .then(({first, second}) => {
            const refImg = {size: {width: first.width, height: first.height}};
            const metaInfo = {refImg};

            if (first.width !== second.width || first.height !== second.height) {
                const diffBounds = getMaxDiffBounds(first, second);
                process.nextTick(() => callback(null, {equal: false, metaInfo, diffBounds, diffClusters: [diffBounds]}));

                const end2 = process.hrtime(start);
                console.log(`hermione:looks-same: ref src: ${image1.source}, actual src: ${image2.source}, buf1: ${first._png.data.length}, buf2: ${second._png.data.length}, exec_time: ${end2[0]}s ${end2[1] / 1e6}ms, BUFFERS ARE ${buffEquals ? 'EQUAL' : 'NOT EQUAL'} AND IMAGE SIZES NOT EQUAL`);

                return;
            }

            const comparator = createComparator(first, second, opts);
            const {stopOnFirstFail, shouldCluster, clustersSize} = opts;

            getDiffPixelsCoords(first, second, comparator, {stopOnFirstFail, shouldCluster, clustersSize}, ({diffArea, diffClusters}) => {
                const diffBounds = diffArea.area;
                const equal = diffArea.isEmpty();

                callback(null, {equal, metaInfo, diffBounds, diffClusters});

                const end3 = process.hrtime(start);
                console.log(`hermione:looks-same: ref src: ${image1.source}, actual src: ${image2.source}, buf1: ${first._png.data.length}, buf2: ${second._png.data.length}, exec_time: ${end3[0]}s ${end3[1] / 1e6}ms, BUFFERS ARE ${buffEquals ? 'EQUAL' : 'NOT EQUAL'} AND IMAGES ARE ${equal ? 'EQUAL' : 'NOT EQUAL'}`);
            });
        })
        .catch(error => {
            callback(error);
            const end4 = process.hrtime(start);
            console.log(`hermione:looks-same: ref src: ${image1.source}, actual src: ${image2.source}, buf1: ${buffData1.source.length}, buf2: ${buffData2.source.length}, exec_time: ${end4[0]}s ${end4[1] / 1e6}ms, BUFFERS ARE ${buffEquals ? 'EQUAL' : 'NOT EQUAL'} AND ERROR APPEARS:`, error);
        });
};

exports.getDiffArea = function(image1, image2, opts, callback) {
    if (!callback) {
        callback = opts;
        opts = {};
    }

    opts = prepareOpts(opts);
    [image1, image2] = utils.formatImages(image1, image2);

    utils
        .readPair(image1, image2)
        .then(({first, second}) => {
            if (first.width !== second.width || first.height !== second.height) {
                return process.nextTick(() => callback(null, getMaxDiffBounds(first, second)));
            }

            const comparator = createComparator(first, second, opts);

            getDiffPixelsCoords(first, second, comparator, opts, ({diffArea}) => {
                if (diffArea.isEmpty()) {
                    return callback(null, null);
                }

                callback(null, diffArea.area);
            });
        })
        .catch(error => {
            callback(error);
        });
};

exports.createDiff = function saveDiff(opts, callback) {
    opts = prepareOpts(opts);

    const [image1, image2] = utils.formatImages(opts.reference, opts.current);

    utils
        .readPair(image1, image2)
        .then(({first, second}) => {
            const diffOptions = {
                highlightColor: parseColorString(opts.highlightColor),
                comparator: createComparator(first, second, opts)
            };

            buildDiffImage(first, second, diffOptions, (result) => {
                if (opts.diff === undefined) {
                    result.createBuffer(callback);
                } else {
                    result.save(opts.diff, callback);
                }
            });
        })
        .catch(error => {
            callback(error);
        });
};

exports.colors = (color1, color2, opts) => {
    opts = opts || {};

    if (opts.tolerance === undefined) {
        opts.tolerance = JND;
    }

    const comparator = makeCIEDE2000Comparator(opts.tolerance);

    return comparator({color1, color2});
};
