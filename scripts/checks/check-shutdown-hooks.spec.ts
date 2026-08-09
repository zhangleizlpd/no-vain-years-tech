import { describe, expect, it } from 'vitest';
import { checkBootstrap } from './check-shutdown-hooks';

const ok = `
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(3000);
`;

describe('check-shutdown-hooks', () => {
  it('listen() 前调用了 enableShutdownHooks → 通过', () => {
    expect(checkBootstrap(ok)).toBeNull();
  });

  it('🚨 完全没调用 → 报错（#824 的原始状态）', () => {
    const src = `const app = await NestFactory.create(AppModule);\n  await app.listen(3000);`;
    expect(checkBootstrap(src)).toContain('缺 `app.enableShutdownHooks()`');
  });

  it('🚨 调用在 listen() 之后 → 报错（存在「已收流量但钩子未挂」的窗口）', () => {
    const src = `await app.listen(3000);\n  app.enableShutdownHooks();`;
    expect(checkBootstrap(src)).toContain('之后');
  });

  it('只在注释里出现不算数（剥注释后匹配）', () => {
    const src = `// app.enableShutdownHooks();\n  /* app.enableShutdownHooks(); */\n  await app.listen(3000);`;
    expect(checkBootstrap(src)).toContain('缺 `app.enableShutdownHooks()`');
  });

  it('🚨 **行尾**注释也不算数 —— 写在 listen() 之前时曾是漏报（真调用缺失却通过）', () => {
    // 顺序检查兜不住这一形态: 注释位置在 listen 之前, hookAt < listenAt, 两道判断全过。
    const src = `const app = await NestFactory.create(AppModule); // 别忘了 app.enableShutdownHooks()\n  await app.listen(3000);`;
    expect(checkBootstrap(src)).toContain('缺 `app.enableShutdownHooks()`');
  });

  it('剥行尾注释不误伤日志模板里的 URL（main.ts 真有 http://localhost）', () => {
    const src = `app.enableShutdownHooks();\n  log(\`running on http://localhost:3000/api\`);\n  await app.listen(3000);`;
    expect(checkBootstrap(src)).toBeNull();
  });

  it('允许换行/空格写法', () => {
    expect(checkBootstrap(`app\n  .enableShutdownHooks ();\n  await app.listen(3000);`)).toBeNull();
  });
});
