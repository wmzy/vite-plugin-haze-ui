import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, it, vi} from 'vitest';

import hazeCssDefault, {hazeCss} from '../src/index.ts';
import type {Plugin} from 'vite';

// —— fixture：tmp 目录内一份假 haze-ui 安装（node_modules/haze-ui）——
// package.json 不带 exports，让 `haze-ui/css/<x>.css` 直接按子路径落盘。

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

type FixtureOptions = {manifest?: 'good' | 'broken' | 'none'};

async function fixture(options: FixtureOptions = {}) {
  const tmp = await fs.promises.mkdtemp(join(tmpdir(), 'vite-plugin-haze-ui-'));
  tmpDirs.push(tmp);
  const cssDir = join(tmp, 'node_modules', 'haze-ui', 'css');
  await fs.promises.mkdir(cssDir, {recursive: true});
  await fs.promises.writeFile(
    join(tmp, 'node_modules', 'haze-ui', 'package.json'),
    JSON.stringify({name: 'haze-ui', version: '0.0.0-fixture'})
  );
  for (const f of CSS_FILES) {
    await fs.promises.writeFile(join(cssDir, f), `/* ${f} */\n`);
  }
  const kind = options.manifest ?? 'good';
  if (kind !== 'none') {
    await fs.promises.writeFile(
      join(cssDir, '..', 'css-manifest.json'),
      kind === 'broken' ? '{ 不是 json' : JSON.stringify(GOOD_MANIFEST)
    );
  }
  const consumer = join(tmp, 'app.ts');
  await fs.promises.writeFile(consumer, '');
  return {tmp, consumer};
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
});

// —— 真实契约冒烟（gated）：本机存在 haze-ui dist 时才跑 ——
const REAL_HAZE_UI = '/home/zlt/projects/haze-ui';
const realManifestPath = join(REAL_HAZE_UI, 'dist', 'css-manifest.json');
const haveReal = fs.existsSync(realManifestPath);

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
