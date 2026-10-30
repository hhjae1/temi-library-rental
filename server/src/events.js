// 앱·관리자 화면에 실시간 상태를 보내는 Server-Sent Events 허브
export function createEventHub(bus) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  };
  for (const event of ['request', 'items', 'rental', 'robot']) bus.on(event, (data) => broadcast(event, data));

  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25_000);

  return {
    handler(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    close() {
      clearInterval(keepAlive);
      for (const res of clients) res.end();
    },
  };
}
