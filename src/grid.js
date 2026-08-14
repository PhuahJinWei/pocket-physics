// Uniform spatial hash built with a counting sort. Allocation-free after
// warm-up: build() only touches pre-sized typed arrays.
//
// Layout: cellStart[c]..cellStart[c+1] indexes into `order`, which holds grain
// indices grouped by cell. Cells are row-major over the sim rectangle.

export class Grid {
  constructor(capacity) {
    this.cols = 0;
    this.rows = 0;
    this.cellCount = 0;
    this.cellSize = 1;
    this.originX = 0;
    this.originY = 0;
    this.cellStart = new Int32Array(1);
    this.cursor = new Int32Array(1);
    this.cellOrder = new Int32Array(1);
    this.order = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
  }

  ensureCapacity(n) {
    if (this.order.length >= n) return;
    this.order = new Int32Array(n);
    this.cellOf = new Int32Array(n);
  }

  configure(x0, y0, width, height, cellSize) {
    this.originX = x0;
    this.originY = y0;
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.cellCount = this.cols * this.rows;
    if (this.cellStart.length < this.cellCount + 1) {
      this.cellStart = new Int32Array(this.cellCount + 1);
      this.cursor = new Int32Array(this.cellCount + 1);
      this.cellOrder = new Int32Array(this.cellCount);
    }
  }

  build(x, y, n) {
    const cols = this.cols;
    const rows = this.rows;
    const cells = this.cellCount;
    const start = this.cellStart;
    const cursor = this.cursor;
    const cellOf = this.cellOf;
    const order = this.order;
    const inv = 1 / this.cellSize;
    const ox = this.originX;
    const oy = this.originY;

    start.fill(0, 0, cells + 1);

    for (let i = 0; i < n; i++) {
      let cx = ((x[i] - ox) * inv) | 0;
      let cy = ((y[i] - oy) * inv) | 0;
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      const c = cy * cols + cx;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];

    cursor.set(start);
    for (let i = 0; i < n; i++) order[cursor[cellOf[i]]++] = i;
  }

  /**
   * Order cells deepest-first along the gravity direction. Resolving contacts
   * from the base of a pile upward lets support propagate in a single sweep,
   * which is what keeps stacks from sinking with only a couple of iterations.
   */
  orderCellsByGravity(gx, gy) {
    const cols = this.cols;
    const rows = this.rows;
    const out = this.cellOrder;
    const yMajor = Math.abs(gy) >= Math.abs(gx);
    const yStart = gy >= 0 ? rows - 1 : 0;
    const yStep = gy >= 0 ? -1 : 1;
    const xStart = gx >= 0 ? cols - 1 : 0;
    const xStep = gx >= 0 ? -1 : 1;

    let k = 0;
    if (yMajor) {
      for (let a = 0; a < rows; a++) {
        const base = (yStart + a * yStep) * cols;
        for (let b = 0; b < cols; b++) out[k++] = base + xStart + b * xStep;
      }
    } else {
      for (let b = 0; b < cols; b++) {
        const col = xStart + b * xStep;
        for (let a = 0; a < rows; a++) out[k++] = (yStart + a * yStep) * cols + col;
      }
    }
    return out;
  }
}
