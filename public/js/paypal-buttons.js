// Loads the PayPal JS SDK on demand and renders Smart Payment Buttons for the
// first tap from a payer who has not saved PayPal yet (sandbox mode only).

let sdkPromise;

function loadSdk(clientId, currency) {
  if (window.paypal?.Buttons) return Promise.resolve(window.paypal);
  sdkPromise =
    sdkPromise ||
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture&components=buttons&enable-funding=venmo`;
      s.onload = () => resolve(window.paypal);
      s.onerror = () => reject(new Error('Could not load PayPal'));
      document.head.appendChild(s);
    });
  return sdkPromise;
}

export async function renderPayPalButtons({ container, clientId, currency = 'USD', createOrder, onApprove, onError }) {
  if (!clientId) throw new Error('PayPal client id missing');
  const paypal = await loadSdk(clientId, currency);
  const el = document.querySelector(container);
  if (!el) return;
  el.innerHTML = '';
  await paypal
    .Buttons({
      style: { layout: 'vertical', shape: 'pill', label: 'pay', height: 48 },
      createOrder,
      onApprove,
      onError,
      onCancel: () => onError?.(new Error('PayPal approval cancelled')),
    })
    .render(container);
}
