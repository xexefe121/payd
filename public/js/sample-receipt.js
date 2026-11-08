// Ground truth for /img/sample-receipt.svg. Used only when Claude is not configured,
// so the Snap & Split flow can still be demoed end to end.
export const SAMPLE_RECEIPT = {
  merchant: "Luigi's Trattoria",
  currency: 'USD',
  items: [
    { name: 'Margherita Pizza', qty: 1, lineTotal: 18.0 },
    { name: 'Spaghetti Carbonara', qty: 1, lineTotal: 21.5 },
    { name: 'Caesar Salad', qty: 1, lineTotal: 13.0 },
    { name: 'Tiramisu', qty: 2, lineTotal: 16.0 },
    { name: 'Sparkling Water', qty: 3, lineTotal: 10.5 },
  ],
  subtotal: 79.0,
  tax: 7.11,
  tip: 14.22,
  total: 100.33,
};
