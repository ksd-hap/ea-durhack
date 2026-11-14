// Minimal dense linear algebra for agent perception. Pure, no I/O. [Role 2]
// Matrices are row-major Float64Array: M.data[i * M.cols + j] == nested[i][j].
// Convention matches NumPy row vectors: vecMat(x, W) == x @ W.

/** Convert a nested array (rows x cols) from JSON to a flat row-major matrix. */
export function matrix(nested) {
  const rows = nested.length;
  if (rows === 0) throw new Error('matrix: empty');
  const cols = nested[0].length;
  const data = new Float64Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    const r = nested[i];
    if (r.length !== cols) throw new Error(`matrix: ragged row ${i} (${r.length} != ${cols})`);
    for (let j = 0; j < cols; j++) data[i * cols + j] = r[j];
  }
  return { rows, cols, data };
}

/** Row vector times matrix: v (length M.rows) @ M -> length M.cols. */
export function vecMat(v, M, out = new Float64Array(M.cols)) {
  if (v.length !== M.rows) throw new Error(`vecMat: ${v.length} != ${M.rows}`);
  out.fill(0);
  const { cols, data } = M;
  for (let i = 0; i < M.rows; i++) {
    const vi = v[i];
    if (vi === 0) continue;
    const off = i * cols;
    for (let j = 0; j < cols; j++) out[j] += vi * data[off + j];
  }
  return out;
}

export function sub(a, b, out = new Float64Array(a.length)) {
  if (a.length !== b.length) throw new Error(`sub: ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

export function dot(a, b) {
  if (a.length !== b.length) throw new Error(`dot: ${a.length} != ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a) {
  return Math.sqrt(dot(a, a));
}

/** Unit-length copy. A zero vector stays zero (never NaN). */
export function normalise(a) {
  const n = norm(a);
  const out = new Float64Array(a.length);
  if (n === 0 || !Number.isFinite(n)) return out;
  for (let i = 0; i < a.length; i++) out[i] = a[i] / n;
  return out;
}

export function cosine(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** Mean of dot(u, r) over rows r. With unit u and unit rows this is the mean cosine. */
export function meanDot(u, rows) {
  let s = 0;
  for (const r of rows) s += dot(u, r);
  return s / rows.length;
}
