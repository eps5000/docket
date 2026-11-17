/**
 * The only door into the sealed network (tasks.md T145; docker/compose.no-egress.yaml).
 *
 * Docker doesn't publish ports for a container that is only on an internal
 * network, so this forwarder sits on both networks: it listens on 7420 on the
 * normal one (published to 127.0.0.1 as usual) and passes each TCP connection
 * to tasklite:7420 on the sealed one. Bytes go through untouched, so the Host
 * and Origin headers the guards check are the browser's own. Traffic only
 * ever flows inwards: tasklite itself has no route out.
 */
import net from 'node:net';

const target = { host: process.env.GATEWAY_TARGET_HOST ?? 'tasklite', port: 7420 };
net
  .createServer((client) => {
    const upstream = net.connect(target);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
  })
  .listen(7420, '0.0.0.0', () => console.log(`gateway: :7420 → ${target.host}:${target.port}`));
