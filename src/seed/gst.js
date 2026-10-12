/**
 * Intra-state GST in integer paise. CGST is 9% truncated.
 * Any remainder of the 18% total sits on SGST so the invoice still balances.
 * @param {number} revenuePaise
 */
export function splitGst(revenuePaise) {
  if (!Number.isInteger(revenuePaise) || revenuePaise <= 0) {
    throw new Error("Revenue paise must be a positive integer.");
  }
  const cgst = Math.floor((revenuePaise * 9) / 100);
  const gst = Math.floor((revenuePaise * 18) / 100);
  return { cgst, sgst: gst - cgst };
}
