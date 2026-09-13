// ============================================================
// downloadUtil.js  — TEMP DEBUG helper
// Job: shared JSON download trigger used by both the reference-data
//      export and the DTW debug export.  Easy to remove afterward.
// ============================================================

/**
 * Triggers a browser download of a JSON-serialised value.
 * @param {string} filename  Desired file name (e.g. "data.json").
 * @param {any}    data      JavaScript value to serialise.
 * @param {number} [indent=2] Spaces for pretty-printing.
 */
export function downloadJson(filename, data, indent = 2) {
  const json = JSON.stringify(data, null, indent);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
