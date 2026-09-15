import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, it, vi} from 'vitest';

import hazeCssDefault, {hazeCss} from '../src/index.ts';
import type {Plugin} from 'vite';

// —— fixture：tmp 目录内一份假组件库安装（node_modules/<pkgName>）——
// package.json 不带 exports，让 `<pkgName>/css/<x>.css` 直接按子路径落盘。

const GOOD_MANIFEST = {
  families: {
    Button: 'button',
    Title: 'typography',
    Text: 'typography',
    OTPInput: 'otp-input',
    ListItem: 'list',
    InputCore: 'input',
    // 登记了家族但故意不落 calendar.css 文件 → 「期望 css 缺失」用例
    Calendar: 'calendar'
  },
  noCss: ['useControl', 'useTitle']
};

const CSS_FILES = [
  'tokens.css',
  'button.css',
  'typography.css',
  'otp-input.css',
  'list.css',
  'input.css'
];

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => fs.promises.rm(d, {recursive: true, force: true}))
  );
});

type FixtureOptions = {manifest?: 'good' | 'broken' | 'none'; pkgName?: string};

async function fixture(options: FixtureOptions = {}) {
  const pkgName = options.pkgName ?? 'haze-ui';
  const tmp = await fs.promises.mkdtemp(join(tmpdir(), 'vite-plugin-haze-ui-'));
  tmpDirs.push(tmp);
  const cssDir = join(tmp, 'node_modules', pkgName, 'css');
  await fs.promises.mkdir(cssDir, {recursive: true});
  await fs.promises.writeFile(
    join(tmp, 'node_modules', pkgName, 'package.json'),
    JSON.stringify({name: pkgName, version: '0.0.0-fixture'})
  );
  for (const f of CSS_FILES) {
    await fs.promises.writeFile(join(cssDir, f), `/* ${f} */\n`);
  }
  const kind = options.manifest ?? 'good';
  const manifestPath = join(cssDir, '..', 'css-manifest.json');
  if (kind !== 'none') {
    await fs.promises.writeFile(
      manifestPath,
      kind === 'broken' ? '{ 不是 json' : JSON.stringify(GOOD_MANIFEST)
    );
  }
  const consumer = join(tmp, 'app.ts');
  await fs.promises.writeFile(consumer, '');
  return {tmp, consumer, manifestPath};
}

// —— 驱动器：以 mock this 调 plugin.transform ——

type Ctx = {error: (message: string) => never; warn: ReturnType<typeof vi.fn>};

function run(plugin: Plugin, code: string, id: string) {
  const warn = vi.fn();
  const ctx: Ctx = {
    error: (message) => {
      throw new Error(message);
    },
    warn
  };
  const transform = plugin.transform as unknown as (
    this: Ctx,
    code: string,
    id: string
  ) => string | null;
  return {result: transform.call(ctx, code, id), warn};
}

const injected = (result: string) =>
  result.split('\n').filter((l) => l.startsWith('import "'));

describe('vite-plugin-haze-ui', () => {
  it('exposes default and named export', () => {
    expect(hazeCssDefault).toBe(hazeCss);
    expect(hazeCss().name).toBe('vite-plugin-haze-ui:haze-css');
  });

  it('sets no enforce so it runs after the builtin TS/JSX transform', () => {
    // 运行阶段契约：normal 顺序下到达 transform 的已是纯 ESM JS（类型已
    // 剥离、JSX 已编译），正是 es-module-lexer 的解析面。设了 enforce:
    // 'pre' 会先于该转换看到原始 TSX，JSX 直接令 lexer 抛 ParseError
    //（1.0.0 缺陷：真实 React 项目任何含 JSX 的模块都会炸构建）。
    expect(hazeCss().enforce).toBeUndefined();
  });

  it('injects from post-transform ESM on the lexer path without warnings', async () => {
    const {consumer} = await fixture();
    const code =
      `import {jsx as _jsx} from "react/jsx-runtime";\n` +
      `import {Button} from 'haze-ui';\n` +
      `export const App = () => _jsx("div", {children: _jsx("span")});\n`;
    const {result, warn} = run(hazeCss(), code, consumer);
    expect(warn).not.toHaveBeenCalled();
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/button.css";'
    ]);
  });

  it('falls back to regex scan with a warning when the lexer cannot parse (raw JSX)', async () => {
    const {tmp} = await fixture();
    const consumer = join(tmp, 'App.tsx');
    await fs.promises.writeFile(consumer, '');
    // 点号标签 + 属性表达式 + 自闭合子件的 JSX 令 lexer 抛 ParseError
    //（文本子件反而会被宽容解析——逐形态探测后选定的稳定触发式；真实
    // 炸点与 painless 集成 1.0.0 时的形态一致）。
    const code =
      `import {Button} from 'haze-ui'; ` +
      `export const App = () => <Theme.Provider value={x}><Button /></Theme.Provider>;\n`;
    const {result, warn} = run(hazeCss(), code, consumer);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('es-module-lexer');
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/button.css";'
    ]);
  });

  it('injects tokens.css + family css, tokens first', async () => {
    const {consumer} = await fixture();
    const code = `import {Button} from 'haze-ui';\nexport const x = 1;\n`;
    const {result} = run(hazeCss(), code, consumer);
    expect(result).not.toBeNull();
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/button.css";'
    ]);
    expect(result!.endsWith(code)).toBe(true);
  });

  it('dedupes same-family imports (Title+Text → typography)', async () => {
    const {consumer} = await fixture();
    const code = `import {Title, Text} from 'haze-ui';\n`;
    const {result} = run(hazeCss(), code, consumer);
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/typography.css";'
    ]);
  });

  it('skips noCss exports (useControl injects only tokens)', async () => {
    const {consumer} = await fixture();
    const {result} = run(
      hazeCss(),
      `import {useControl} from 'haze-ui';\n`,
      consumer
    );
    expect(injected(result!)).toEqual(['import "haze-ui/css/tokens.css";']);
  });

  it('skips `import type` statements and inline type specifiers', async () => {
    const {consumer} = await fixture();
    const code =
      `import type {TitleProps} from 'haze-ui';\n` +
      `import {type TextProps, Text} from 'haze-ui';\n`;
    const {result} = run(hazeCss(), code, consumer);
    // TitleProps/TextProps 未被识别为值导入（否则 manifest 缺口即报错）
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/typography.css";'
    ]);
  });

  it('ignores imports inside comments', async () => {
    const {consumer} = await fixture();
    const code =
      `// import {Button} from 'haze-ui';\n` +
      `/* import {OTPInput} from 'haze-ui'; */\n` +
      `export {};\n`;
    const {result} = run(hazeCss(), code, consumer);
    expect(result).toBeNull();
  });

  it('warns on namespace imports and injects nothing', async () => {
    const {consumer} = await fixture();
    const {result, warn} = run(
      hazeCss(),
      `import * as haze from 'haze-ui';\n`,
      consumer
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('命名空间导入');
  });

  it('errors with four essentials when the expected css is missing', async () => {
    const {consumer} = await fixture();
    let message = '';
    try {
      run(hazeCss(), `import {Calendar} from 'haze-ui';\n`, consumer);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    // 四要素：源文件、导入名、期望 css 路径、修复提示
    expect(message).toContain(consumer);
    expect(message).toContain('Calendar');
    expect(message).toContain('haze-ui/css/calendar.css');
    expect(message).toContain('修复');
  });

  it('errors on manifest coverage gaps (present but not listed)', async () => {
    const {consumer} = await fixture();
    let message = '';
    try {
      run(hazeCss(), `import {FutureThing} from 'haze-ui';\n`, consumer);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('FutureThing');
    expect(message).toContain('css-manifest.json');
    expect(message).toContain('未列出');
  });

  it('errors on a broken css-manifest.json', async () => {
    const {consumer} = await fixture({manifest: 'broken'});
    let message = '';
    try {
      run(hazeCss(), `import {Button} from 'haze-ui';\n`, consumer);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('css-manifest.json');
    expect(message).toContain('不可用');
  });

  it('falls back to FAMILY/NO_CSS tables when the manifest is absent', async () => {
    const {consumer} = await fixture({manifest: 'none'});
    const {result} = run(
      hazeCss(),
      `import {Title, Text, Button, useControl, OTPInput} from 'haze-ui';\n`,
      consumer
    );
    // FAMILY: Title/Text→typography（去重）；kebab: Button→button、
    // OTPInput→otp-input；NO_CSS: useControl→无 css
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/typography.css";',
      'import "haze-ui/css/button.css";',
      'import "haze-ui/css/otp-input.css";'
    ]);
  });

  it('returns null for non-source files, node_modules and virtual modules', async () => {
    const {tmp} = await fixture();
    const code = `import {Button} from 'haze-ui';\n`;
    expect(run(hazeCss(), code, join(tmp, 'index.html')).result).toBeNull();
    expect(
      run(hazeCss(), code, join(tmp, 'node_modules', 'other', 'lib', 'i.js'))
        .result
    ).toBeNull();
    expect(run(hazeCss(), code, '\0virtual-haze.ts').result).toBeNull();
  });

  it('does not resolve haze-ui from the plugin location', async () => {
    // 本包自身 devDependencies 里没有 haze-ui：若解析基准错误地取插件
    // 位置（createRequire(import.meta.url)），tokens 解析必然失败。
    // 该用例与上方注入用例共同钉住「从消费方模块解析」这一核心。
    const {consumer} = await fixture();
    const {result} = run(hazeCss(), `import {Button} from 'haze-ui';\n`, consumer);
    expect(injected(result!)).toContain('import "haze-ui/css/button.css";');
  });

  it('handles aliases, double quotes, multiline and CRLF imports', async () => {
    const {consumer} = await fixture();
    const code =
      `import {Button as Btn} from "haze-ui";\r\n` +
      `import {\n  Title,\n  Text,\n} from 'haze-ui';\n`;
    const {result} = run(hazeCss(), code, consumer);
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/button.css";',
      'import "haze-ui/css/typography.css";'
    ]);
  });

  it('finds imports on the same line as // inside strings or regex literals', async () => {
    // 旧 stripComments 正则法会把 '//' 之后的同行内容全当注释吞掉，
    // 真实 import 静默丢失；es-module-lexer 无此假阴性。
    const {consumer} = await fixture();
    const code =
      `const u = 'http://x'; import {Button} from 'haze-ui';\n` +
      String.raw`const re = /https?:\/\//; import {Title} from 'haze-ui';` +
      `\n`;
    const {result} = run(hazeCss(), code, consumer);
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/button.css";',
      'import "haze-ui/css/typography.css";'
    ]);
  });

  it('ignores import-shaped text inside strings and template literals', async () => {
    const {consumer} = await fixture();
    const code =
      `const s = "import {Button} from 'haze-ui';";\n` +
      'const t = `import {OTPInput} from "haze-ui";`;\n' +
      'export {};\n';
    const {result} = run(hazeCss(), code, consumer);
    expect(result).toBeNull();
  });

  it('processes source files whose path merely contains "node_modules"', async () => {
    const {tmp} = await fixture();
    const dir = join(tmp, 'workspace-node_modules-shim');
    await fs.promises.mkdir(dir, {recursive: true});
    const consumer = join(dir, 'App.tsx');
    await fs.promises.writeFile(consumer, '');
    const {result} = run(
      hazeCss(),
      `import {Button} from 'haze-ui';\n`,
      consumer
    );
    expect(injected(result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/button.css";'
    ]);
  });

  it('re-reads the css-manifest when it changes on disk (no restart)', async () => {
    const {consumer, manifestPath} = await fixture();
    const code = `import {Button} from 'haze-ui';\n`;
    expect(injected(run(hazeCss(), code, consumer).result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/button.css";'
    ]);
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify({
        families: {...GOOD_MANIFEST.families, Button: 'typography'},
        noCss: GOOD_MANIFEST.noCss
      })
    );
    // 强制 mtime 前进，避免粗粒度文件系统同一 tick 内指纹不变
    await fs.promises.utimes(
      manifestPath,
      new Date('2000-01-01'),
      new Date('2026-01-01')
    );
    expect(injected(run(hazeCss(), code, consumer).result!)).toEqual([
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/typography.css";'
    ]);
  });

  it('appends the resolution cause when package exports hide ./css/*', async () => {
    const {tmp} = await fixture();
    // exports 只暴露 tokens → 组件 css 的 resolve 抛
    // ERR_PACKAGE_PATH_NOT_EXPORTED，报错需附原始原因而非「文件不存在」
    await fs.promises.writeFile(
      join(tmp, 'node_modules', 'haze-ui', 'package.json'),
      JSON.stringify({
        name: 'haze-ui',
        version: '0.0.0-fixture',
        exports: {'./css/tokens.css': './css/tokens.css'}
      })
    );
    const consumer = join(tmp, 'app.ts');
    let message = '';
    try {
      run(hazeCss(), `import {Button} from 'haze-ui';\n`, consumer);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(message).toContain('Button');
  });

  it('handles .mts and .cts consumer files', async () => {
    const {tmp} = await fixture();
    const mts = join(tmp, 'app.mts');
    const cts = join(tmp, 'app.cts');
    await fs.promises.writeFile(mts, '');
    await fs.promises.writeFile(cts, '');
    const code = `import {Button} from 'haze-ui';\n`;
    const expected = [
      'import "haze-ui/css/tokens.css";',
      'import "haze-ui/css/button.css";'
    ];
    expect(injected(run(hazeCss(), code, mts).result!)).toEqual(expected);
    expect(injected(run(hazeCss(), code, cts).result!)).toEqual(expected);
  });

  it('warns and skips when the module id has no on-disk file', async () => {
    const {tmp} = await fixture();
    const {result, warn} = run(
      hazeCss(),
      `import {Button} from 'haze-ui';\n`,
      join(tmp, 'ghost.tsx')
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('不存在');
  });

  it('packageName option scans the configured package', async () => {
    const {consumer} = await fixture({pkgName: 'haze-x'});
    const code = `import {Button} from 'haze-x';\n`;
    // 默认 pkg 不命中其它包
    expect(run(hazeCss(), code, consumer).result).toBeNull();
    const {result} = run(hazeCss({packageName: 'haze-x'}), code, consumer);
    expect(injected(result!)).toEqual([
      'import "haze-x/css/tokens.css";',
      'import "haze-x/css/button.css";'
    ]);
  });
});

// —— 真实契约冒烟（opt-in）：HAZE_UI_PATH 指向本地 haze-ui 开发目录时才跑
// （如 HAZE_UI_PATH=/home/zlt/projects/haze-ui pnpm test）；CI 与未设置该
// 环境变量的环境自动 skip。
const REAL_HAZE_UI = process.env.HAZE_UI_PATH;
const realManifestPath = REAL_HAZE_UI
  ? join(REAL_HAZE_UI, 'dist', 'css-manifest.json')
  : '';
const haveReal = realManifestPath !== '' && fs.existsSync(realManifestPath);

(haveReal ? describe : describe.skip)('real haze-ui dist contract', () => {
  it('injects button/otp-input/typography against the real css-manifest', async () => {
    const tmp = await fs.promises.mkdtemp(join(tmpdir(), 'vite-plugin-haze-ui-real-'));
    tmpDirs.push(tmp);
    await fs.promises.mkdir(join(tmp, 'node_modules'), {recursive: true});
    await fs.promises.symlink(
      REAL_HAZE_UI,
      join(tmp, 'node_modules', 'haze-ui'),
      'dir'
    );
    const consumer = join(tmp, 'app.ts');
    await fs.promises.writeFile(consumer, '');

    const cases: readonly (readonly [string, string[]])[] = [
      [`import {Button} from 'haze-ui';\n`, ['tokens', 'button']],
      [`import {OTPInput} from 'haze-ui';\n`, ['tokens', 'otp-input']],
      [`import {Title, Text} from 'haze-ui';\n`, ['tokens', 'typography']]
    ];
    for (const [code, files] of cases) {
      const {result} = run(hazeCss(), code, consumer);
      expect(injected(result!)).toEqual(
        files.map((f) => `import "haze-ui/css/${f}.css";`)
      );
    }
  });
});
