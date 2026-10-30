// The SSR pre/post diff engine, ported from pre-post-check-gui.py.
//
// flatten() and computeChanges() are direct translations. charDiff() needed
// difflib.SequenceMatcher, which JS has no equivalent of, so the algorithm is
// implemented here rather than approximated — autojunk disabled, as the Python
// specified, so no element is ever skipped for being "popular".

/** flatten: recursively flatten dict/list into {dotted.key: string}. */
export function flatten(obj, prefix = "", sep = ".") {
  const out = {};
  const walk = (value, pre) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, pre ? `${pre}${sep}${k}` : String(k));
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${pre}[${i}]`));
    } else {
      out[pre] = value === null || value === undefined ? "" : String(value);
    }
  };
  walk(obj, prefix);
  return out;
}

/**
 * compute_changes: every dotted path whose value differs, classified.
 * @returns {Array<{command: string, path: string, pre: string, post: string, change: string}>}
 */
export function computeChanges(pre, post, cmdKey) {
  const pf = flatten(pre);
  const qf = flatten(post);
  const rows = [];
  for (const k of [...new Set([...Object.keys(pf), ...Object.keys(qf)])].sort()) {
    const inPre = Object.prototype.hasOwnProperty.call(pf, k);
    const inPost = Object.prototype.hasOwnProperty.call(qf, k);
    const v1 = inPre ? pf[k] : null;
    const v2 = inPost ? qf[k] : null;
    if (v1 !== v2) {
      rows.push({
        command: cmdKey,
        path: k,
        pre: v1 === null ? "" : v1,
        post: v2 === null ? "" : v2,
        change: !inPre ? "Added" : !inPost ? "Removed" : "Changed",
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// difflib.SequenceMatcher, autojunk=False
// ---------------------------------------------------------------------------

class SequenceMatcher {
  constructor(a, b) {
    this.a = a;
    this.b = b;
    this.b2j = new Map();
    for (let i = 0; i < b.length; i += 1) {
      const ch = b[i];
      if (!this.b2j.has(ch)) this.b2j.set(ch, []);
      this.b2j.get(ch).push(i);
    }
  }

  /**
   * The longest matching block in a[alo:ahi] and b[blo:bhi], preferring the
   * earliest such block, then extending it over equal elements at both edges.
   */
  findLongestMatch(alo, ahi, blo, bhi) {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();

    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }

    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1; bestj -= 1; bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi
      && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize += 1;
    }
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks() {
    const la = this.a.length;
    const lb = this.b.length;
    const queue = [[0, la, 0, lb]];
    const blocks = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (!k) continue;
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

    // Adjacent equal blocks are merged, then the sentinel is appended.
    const merged = [];
    let [i1, j1, k1] = [0, 0, 0];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) merged.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([la, lb, 0]);
    return merged;
  }

  getOpcodes() {
    let i = 0;
    let j = 0;
    const answer = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    return answer;
  }
}

export { SequenceMatcher };

/**
 * char_diff: character-level segments for a side-by-side view.
 * @returns {[Array<[string, boolean]>, Array<[string, boolean]>]} pre, post —
 *   each a list of [text, isHighlighted].
 */
export function charDiff(a, b) {
  // Index by code point on both sides: slicing the strings by the matcher's
  // indices would split characters outside the BMP.
  const ca = [...String(a ?? "")];
  const cb = [...String(b ?? "")];
  const sa = { slice: (i, j) => ca.slice(i, j).join("") };
  const sb = { slice: (i, j) => cb.slice(i, j).join("") };
  const sm = new SequenceMatcher(ca, cb);
  const pre = [];
  const post = [];
  for (const [tag, i1, i2, j1, j2] of sm.getOpcodes()) {
    if (tag === "equal") {
      pre.push([sa.slice(i1, i2), false]);
      post.push([sb.slice(j1, j2), false]);
    } else if (tag === "delete") {
      pre.push([sa.slice(i1, i2), true]);
    } else if (tag === "insert") {
      post.push([sb.slice(j1, j2), true]);
    } else {
      pre.push([sa.slice(i1, i2), true]);
      post.push([sb.slice(j1, j2), true]);
    }
  }
  return [pre, post];
}
