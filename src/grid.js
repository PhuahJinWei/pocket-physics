// Uniform 3D spatial hash built with a counting sort. Allocation-free after
// warm-up: build() only touches pre-sized typed arrays.
//
// Layout: cellStart[c]..cellStart[c+1] indexes into `order`, which holds grain
// indices grouped by cell. Cells are x-major, then y, then z slabs — index
// (z * rows + y) * cols + x over the shallow sim box.

export class Grid {
  constructor(capacity) {
    this.cols = 0;
    this.rows = 0;
    this.slabs = 0;
    this.cellCount = 0;
    this.cellSize = 1;
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

  configure(width, height, depth, cellSize) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.slabs = Math.max(1, Math.ceil(depth / cellSize));
    this.cellCount = this.cols * this.rows * this.slabs;
    if (this.cellStart.length < this.cellCount + 1) {
      this.cellStart = new Int32Array(this.cellCount + 1);
      this.cursor = new Int32Array(this.cellCount + 1);
      this.cellOrder = new Int32Array(this.cellCount);
    }
  }

  build(x, y, z, n) {
    const cols = this.cols;
    const rows = this.rows;
    const slabs = this.slabs;
    const layer = cols * rows;
    const cells = this.cellCount;
    const start = this.cellStart;
    const cursor = this.cursor;
    const cellOf = this.cellOf;
    const order = this.order;
    const inv = 1 / this.cellSize;

    start.fill(0, 0, cells + 1);

    for (let i = 0; i < n; i++) {
      let cx = (x[i] * inv) | 0;
      let cy = (y[i] * inv) | 0;
      let cz = (z[i] * inv) | 0;
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      if (cz < 0) cz = 0; else if (cz >= slabs) cz = slabs - 1;
      const c = cz * layer + cy * cols + cx;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];

    cursor.set(start.subarray(0, cells + 1));
    for (let i = 0; i < n; i++) order[cursor[cellOf[i]]++] = i;
  }

  /**
   * Order cells deepest-first along the gravity direction. Resolving contacts
   * from the base of a pile upward lets support propagate in a single sweep,
   * which is what keeps stacks from sinking with only a couple of iterations.
   * The dominant gravity axis becomes the outermost loop.
   */
  orderCellsByGravity(gx, gy, gz) {
    const axes = [
      { len: this.cols, stride: 1, g: gx },
      { len: this.rows, stride: this.cols, g: gy },
      { len: this.slabs, stride: this.cols * this.rows, g: gz },
    ];
    axes.sort((a, b) => Math.abs(b.g) - Math.abs(a.g));
    for (const a of axes) {
      a.start = a.g >= 0 ? a.len - 1 : 0;
      a.step = a.g >= 0 ? -1 : 1;
    }

    const [a0, a1, a2] = axes;
    const out = this.cellOrder;
    let k = 0;
    for (let i0 = 0; i0 < a0.len; i0++) {
      const o0 = (a0.start + i0 * a0.step) * a0.stride;
      for (let i1 = 0; i1 < a1.len; i1++) {
        const o1 = o0 + (a1.start + i1 * a1.step) * a1.stride;
        for (let i2 = 0; i2 < a2.len; i2++) {
          out[k++] = o1 + (a2.start + i2 * a2.step) * a2.stride;
        }
      }
    }
    return out;
  }
}
