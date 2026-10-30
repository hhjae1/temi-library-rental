import { startServer } from './app.js';

const { port } = await startServer();
console.log(`
TEMI 물품 대여 서버 실행 중
  학생 앱        http://localhost:${port}/
  관리자         http://localhost:${port}/admin/
  TEMI 시뮬레이터 http://localhost:${port}/robot/
`);
