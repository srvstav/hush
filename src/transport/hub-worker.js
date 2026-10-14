// SharedWorker that hosts the relay Hub for every tab of this origin.
// This is how the GitHub Pages demo works with no server at all: same hub code, MessagePorts instead of sockets.

import { Hub } from '../relay/hub.js';

const hub = new Hub();

self.onconnect = (e) => {
  const port = e.ports[0];
  const client = hub.connect({
    send: (b) => port.postMessage(b, [b.buffer]),
    close: () => { client.close(); port.postMessage('closed'); },
    bufferedAmount: 0,
  });
  port.onmessage = ({ data }) => {
    if (data === 'bye') return client.close(); // tab is leaving
    if (data instanceof Uint8Array) client.receive(data);
  };
  port.start();
};
