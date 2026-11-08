// Opens pairs of WebSocket connections to a deployment and reports which server
// instance each lands on. Usage: node demo/instance-probe.mjs https://host [pairs]
import { WebSocket } from 'ws';
const U = process.argv[2].replace(/^http/, 'ws') + '/ws';
const pairs = Number(process.argv[3] || 6);
const open = (id) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(U);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', clientId: id })));
    ws.on('message', (r) => {
      const m = JSON.parse(r);
      if (m.type === 'welcome') resolve({ ws, instance: m.instance });
    });
    ws.on('error', reject);
  });
let same = 0;
for (let i = 0; i < pairs; i++) {
  const [a, b] = await Promise.all([open(`p${i}a`), open(`p${i}b`)]);
  const ok = a.instance === b.instance;
  same += ok;
  console.log(`pair ${i}: ${a.instance} ${b.instance} ${ok ? 'SAME' : 'SPLIT'}`);
  a.ws.close();
  b.ws.close();
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`${same}/${pairs} pairs on the same instance`);
