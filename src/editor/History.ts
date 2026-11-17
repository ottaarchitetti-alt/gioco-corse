/**
 * Annulla / Ripeti (Ctrl+Z / Ctrl+Y).
 * Salviamo una "fotografia" JSON della pista prima di ogni modifica:
 * semplice e affidabile (una pista pesa pochi KB).
 */
export class History<T> {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private readonly limit = 200;

  /** Da chiamare PRIMA di modificare lo stato. */
  record(state: T): void {
    this.undoStack.push(JSON.stringify(state));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Annulla l'ultima "record" se poi non è cambiato nulla (es. click senza trascinare). */
  dropIfUnchanged(state: T): void {
    if (this.undoStack[this.undoStack.length - 1] === JSON.stringify(state)) this.undoStack.pop();
  }

  undo(current: T): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(JSON.stringify(current));
    return JSON.parse(prev) as T;
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(JSON.stringify(current));
    return JSON.parse(next) as T;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
