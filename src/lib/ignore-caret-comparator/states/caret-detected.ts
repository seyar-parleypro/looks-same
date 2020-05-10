import State from "./state";

export default class CaretDetectedState extends State {
    validate(point) {
        return this._isInsideCaret(point);
    }

    _isInsideCaret(point) {
        return (
            point.x >= this.caretTopLeft.x &&
            point.x <= this.caretBottomRight.x &&
            point.y >= this.caretTopLeft.y &&
            point.y <= this.caretBottomRight.y
        );
    }
}
