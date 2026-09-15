// vite-plugin-haze-ui：haze-ui 按需 CSS 自动注入的 Vite 插件（haze-ui 生态官方
// 配套插件包）。机制：transform 阶段用 es-module-lexer 词法扫描模块源码里的
// `import {…} from 'haze-ui'` 具名导入（注释/字符串/模板/正则里的形似文本
// 天然不匹配，既无误识别也无漏识别），把用到的组件映射为
// `haze-ui/css/<family>.css` 的副作用 import 前置注入该模块——css 文件
// 随消费模块一起进模块图，去重、分包（懒加载视图只带自己的组件 css）、
// HMR 全部交给 vite/rollup 原生管道，插件自身零构建状态。
//
// 【运行阶段】本插件不设 enforce（normal 顺序）：vite 内置 TS/JSX 转换
// （vite 5–7 的 vite:esbuild 按 tsconfig 的 jsx 选项、vite 8 的 oxc）先
// 剥离类型并编译 JSX，插件到达时拿到纯 ESM JS——正是 es-module-lexer 的
// 解析面。唯一例外：tsconfig "jsx": "preserve" 的 vite 5–7 项目 JSX 会
// 原样保留到本插件，lexer 无法解析原始 JSX——捕获 ParseError 后降级为
// 注释剥离 + 正则扫描（与旧项目内实现同款，见 transform），并 warn：
// 降级模式下字符串字面量里的形似 import 文本可能被误识别（已知边界）。
//
// 【与项目内实现的关键差异】本包是独立 npm 包，插件代码位于消费项目的
// node_modules 深处，因此 haze-ui 的解析基准必须是**导入方模块**而非插件
// 自身——transform(code, id) 的 id 即导入方文件，用 createRequire(id) 做
// require.resolve（按 id 缓存 require 实例）。这保证 pnpm 严格
// node_modules、monorepo 多副本等形态下，注入的 css 落到该文件实际消费
// 的那份 haze-ui 上。解析出的 css 目录再作为安装键：resolve 缓存与
// css-manifest 三态都按「已定位的安装」隔离，不同文件解析到不同副本时
// 互不串扰。
//
// 家族映射规则（haze-ui dist/css 同目录家族共享一个文件，子组件归并）：
// - 同名文件家族：ListItem→list、TagGroupItem→tag-group、NavLink→
//   navigation-bar、Title/Text/Paragraph→typography、ToastContainer/
//   useToast→toast、FormItem→form、AccordionItem→accordion、
//   CarouselSlide→carousel、ConversationItem→conversation-list、
//   RadioGroup→radio、StepTimelineItem→step-timeline、TimelineItem→
//   timeline、BreadcrumbItem→breadcrumb、GridItem→grid；
// - 受控核心（*Core）与同名完整组件共用家族 css（InputCore→input 等）；
//   ButtonLink 与 Button 共享 button.css；
// - 前缀家族（菜单/浮层类组合件的 Trigger/Content/Item/Separator 子件）：
//   Collapsible{Trigger,Content}→collapsible、Command{Input,List,Item}→
//   command、ContextMenu 四件套→context-menu、DropdownMenu 四件套→
//   dropdown-menu、Menu{Item,Divider}→menu、Tab{,List,Panel}→tabs、
//   Table{Head,Body,Row,Cell}→table、Resizable{Group,Panel,Handle}→
//   resizable、StatGroup→stat、Step→stepper、Option→select（Select 的
//   原生 <option> 子件）；
// - 其余组件按 kebab-case 对应 dist/css/<组件>.css（OTPInput→
//   otp-input.css，连续大写按「词首」断词）。
// 映射源分两档（见 cssFileOf）：haze-ui ≥1.22 随包发布
// dist/css-manifest.json（契约 {"families": {导出名: css 文件名}, "noCss":
// [导出名]}）——文件在场即为唯一映射源，本文件的 FAMILY/NO_CSS 表退役为
// 无该文件时（如 1.21 及更早）的 fallback；无论走哪档，解析出的 css 文件
// 都在 transform 内经 require.resolve 落到该消费文件实际解析的 haze-ui
// 包内做 fs 存在性校验，缺文件即 fail-fast，报错四要素齐：触发注入的源
// 文件、具名导入名、期望 css 路径、修复提示，杜绝注入不存在的文件。
// tokens.css 恒定先行——主题变量/spacing/排版基线都在其中，经去重后落在
// 模块图最前端（入口文件亦导入 haze-ui）。haze-ui 无全局 reset（无
// body/html/* 规则），不存在漏引基础样式的风险。
import {parse, type Import} from 'es-module-lexer';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import type {Plugin} from 'vite';

export type HazeCssOptions = {
  /**
   * 组件库包名（默认 'haze-ui'）。预留泛化：v1 只保证默认值正确工作。
   */
  packageName?: string;
};

// tokens.css 每个 haze-ui 消费模块都注入，rollup 按模块 id 去重后仅保留
// 模块图中最先执行的一份（入口侧），保证先于全部组件 css。

// 子组件 → 家族 css 文件名（不含 .css）。未命中的组件名走 kebab-case。
// 【fallback】本表与下方 NO_CSS 仅在 haze-ui 未随包发布
// dist/css-manifest.json 时生效（manifest 在场则它是唯一映射源）。
const FAMILY: Record<string, string> = {
  // 同名文件家族
  ListItem: 'list',
  TagGroupItem: 'tag-group',
  NavLink: 'navigation-bar',
  Title: 'typography',
  Text: 'typography',
  Paragraph: 'typography',
  ToastContainer: 'toast',
  useToast: 'toast',
  FormItem: 'form',
  AccordionItem: 'accordion',
  BreadcrumbItem: 'breadcrumb',
  CarouselSlide: 'carousel',
  ConversationItem: 'conversation-list',
  RadioGroup: 'radio',
  StepTimelineItem: 'step-timeline',
  TimelineItem: 'timeline',
  GridItem: 'grid',
  // 受控核心（*Core）与同名完整组件共用一份家族 css：haze-<X>Core__*
  // 类就落在 <family>.css 里（1.12.2 接入批换用 *Core 控件时漏登记，
  // kebab 直拼 input-core.css 不存在令 build 失败——补此三条）
  InputCore: 'input',
  TextareaCore: 'textarea',
  TagInputCore: 'tag-input',
  // ButtonLink 与 Button 共享 styles：haze-ButtonLink__* 落在 button.css
  ButtonLink: 'button',
  // 前缀家族：组合件的 Trigger/Content/Item/Separator 等子件
  CollapsibleTrigger: 'collapsible',
  CollapsibleContent: 'collapsible',
  CommandInput: 'command',
  CommandList: 'command',
  CommandItem: 'command',
  ContextMenuTrigger: 'context-menu',
  ContextMenuContent: 'context-menu',
  ContextMenuItem: 'context-menu',
  ContextMenuSeparator: 'context-menu',
  DropdownMenuTrigger: 'dropdown-menu',
  DropdownMenuContent: 'dropdown-menu',
  DropdownMenuItem: 'dropdown-menu',
  DropdownMenuSeparator: 'dropdown-menu',
  MenuItem: 'menu',
  MenuDivider: 'menu',
  Tab: 'tabs',
  TabList: 'tabs',
  TabPanel: 'tabs',
  TableHead: 'table',
  TableBody: 'table',
  TableRow: 'table',
  TableCell: 'table',
  ResizableGroup: 'resizable',
  ResizablePanel: 'resizable',
  ResizableHandle: 'resizable',
  StatGroup: 'stat',
  Step: 'stepper',
  Option: 'select'
};

// kebab-case：双段替换处理「小写|数字→大写」（NumberInput）与「连续
// 大写的词首」（OTPInput→otp-input、AIChat→ai-chat），单段正则对后者
// 会漏插连字符注入不存在的文件。
const kebab = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

// JS-only 导出（主题/设计 token 对象、无样式的纯逻辑 hook）：无对应
// css 文件，不得 kebab 化注入（useControl→use-control.css 不存在）。
// typography token 对象虽与 typography.css 同名，但标题排版 css 由
// Title/Text 家族映射覆盖，纯 token 消费不需要样式。
const NO_CSS = new Set([
  'lightTheme',
  'darkTheme',
  'spacing',
  'typography',
  'TOKEN_REGISTRY',
  'COMPONENT_TOKENS',
  'useControl',
  'useFormControl',
  // 纯逻辑 hook（1.21 上移入主桶，同 useControl 一类）：无样式产物
  'useTitle'
]);

// 提取 import 语句具名导入花括号内的原文：首个 '{' 深度配对到对应 '}'，
// 不受 import attributes（with {…}）等语句尾部花括号干扰。无具名花括号
// （纯 default / 副作用导入）返回 null。
function bracedSpecs(stmt: string): string | null {
  const open = stmt.indexOf('{');
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < stmt.length; i++) {
    const c = stmt[i]!;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return stmt.slice(open + 1, i);
  }
  return null; // 未闭合（词法上不可能，防御）
}

// 具名导入列表按顶层逗号切分：字符串/模板/正则式与注释内的逗号不参与
// 切分，类型里的 {…}/[…]/（…) 也不参与（如
// `import {Button, type Options = {a: string, b: number}}`）。
function splitSpecs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    const next = body[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

// 具名导入体 → names 集合：跳过 inline type 修饰符与空段（尾逗号）。
// lexer 主路径与正则降级路径共用。
function addSpecs(names: Set<string>, body: string): void {
  for (const spec of splitSpecs(body)) {
    const name = spec.replace(/\s+as\s+\S+$/, '').trim();
    if (!name || /^type\s+/.test(name)) continue;
    names.add(name);
  }
}

// —— 正则降级路径辅助（仅 es-module-lexer 解析失败时启用，见 transform）——
// 与旧项目内实现同款：先剥离注释，再匹配具名/命名空间导入。已知边界：
// 字符串/模板字面量里的形似 import 文本会被误命中。
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// haze-ui ≥1.22 随包发布的映射清单（dist/css-manifest.json）。三态：
// absent（未随包发布，走 FAMILY/NO_CSS fallback）/ present（唯一映射源）/
// broken（文件在场但 JSON 坏或形状不对——报错而非静默降级：发布侧 bug
// 伪装成「无 manifest」会倒退回模板猜测映射，正是该文件要消灭的漂移面）。
// 进程内按安装位置读一次。
type CssManifest = {families: Record<string, string>; noCss: string[]};
type ManifestState =
  | {kind: 'absent'}
  | {kind: 'present'; manifest: CssManifest}
  | {kind: 'broken'; problem: string};

// 一份「已定位的组件库安装」的状态：以 dist/css 目录为键（require.resolve
// 默认解析符号链接，pnpm 的 .pnpm 真实路径即安装身份）。
type Install = {
  cssDir: string;
  manifestPath: string;
  // spec → 磁盘真实路径。同一安装内 spec 与文件一一对应，跨消费文件共享。
  resolvedCss: Map<string, string>;
  manifest: ManifestState;
  // mtime+size 指纹：变化即重读 manifest（dev 下改 haze-ui 无需重启）。
  manifestFingerprint: string;
};

const installs = new Map<string, Install>();
const requires = new Map<string, NodeRequire>();

function requireOf(file: string): NodeRequire {
  let req = requires.get(file);
  if (req === undefined) {
    req = createRequire(file);
    requires.set(file, req);
  }
  return req;
}

// 从 dist/css 目录读 manifest（缺失/坏文件的三态判定在这里定型）。
function readManifest(cssDir: string): ManifestState {
  const path = join(cssDir, '..', 'css-manifest.json');
  if (!fs.existsSync(path)) return {kind: 'absent'};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    const {families, noCss} = (parsed ?? {}) as Partial<CssManifest>;
    if (
      typeof families !== 'object' ||
      families === null ||
      !Array.isArray(noCss)
    ) {
      throw new Error('形状不符，期望 {families: {…}, noCss: […]}');
    }
    return {kind: 'present', manifest: {families, noCss}};
  } catch (e) {
    return {
      kind: 'broken',
      problem:
        `haze-ui 的 css-manifest.json（${path}）存在但不可用：` +
        `${e instanceof Error ? e.message : String(e)}。请升级/重装 haze-ui。`
    };
  }
}

// mtime+size 指纹：内容变了就重读（mtime 倒退如 git checkout 旧版同样
// 触发）。文件缺席恒为 'absent'，新出现时指纹变化亦触发重读。
function manifestFingerprint(path: string): string {
  try {
    const st = fs.statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

// 每次 transform 取一次 manifest 状态：指纹未变走缓存，变了重读。
// stat 代价与既有的每模块 existsSync 同量级。
function manifestOf(install: Install): ManifestState {
  const fp = manifestFingerprint(install.manifestPath);
  if (fp !== install.manifestFingerprint) {
    install.manifestFingerprint = fp;
    install.manifest = readManifest(install.cssDir);
  }
  return install.manifest;
}

// 定位消费文件解析到的组件库安装（tokens.css 为锚点）。resolve 结果是
// 符号链接解析后的真实路径，天然作为安装身份键。
function installOf(req: NodeRequire, pkg: string): Install {
  const tokensSpec = `${pkg}/css/tokens.css`;
  const tokensPath = req.resolve(tokensSpec);
  if (!fs.existsSync(tokensPath)) {
    // require.resolve 命中目录（无 exports 映射的兜底）时可能不带文件
    // 后缀，视为不可注入
    throw new Error(`${tokensSpec} 解析到非文件路径 ${tokensPath}`);
  }
  const dir = dirname(tokensPath);
  let install = installs.get(dir);
  if (install === undefined) {
    const manifestPath = join(dir, '..', 'css-manifest.json');
    install = {
      cssDir: dir,
      manifestPath,
      resolvedCss: new Map([[tokensSpec, tokensPath]]),
      manifest: readManifest(dir),
      manifestFingerprint: manifestFingerprint(manifestPath)
    };
    installs.set(dir, install);
  }
  return install;
}

// 注入目标存在性校验：缺文件抛错（由 transform 转为 this.error 并指名
// 是哪个导出、期望哪个 css）。
function resolveCss(
  req: NodeRequire,
  install: Install,
  spec: string
): string {
  let path = install.resolvedCss.get(spec);
  if (path === undefined) {
    path = req.resolve(spec);
    if (!fs.existsSync(path)) {
      throw new Error(`${spec} 解析到非文件路径 ${path}`);
    }
    install.resolvedCss.set(spec, path);
  }
  return path;
}

function cssFileOf(
  name: string,
  state: ManifestState
): {file: string | null; covered: boolean} {
  if (state.kind === 'present') {
    const family = state.manifest.families[name];
    if (typeof family === 'string') {
      // families 值为 css 文件名，容忍带 .css 后缀的写法
      return {file: family.replace(/\.css$/, ''), covered: true};
    }
    if (state.manifest.noCss.includes(name)) return {file: null, covered: true};
    // manifest 覆盖缺口：file 仅用于报错里指认「会猜到哪个文件」
    return {file: kebab(name), covered: false};
  }
  if (NO_CSS.has(name)) return {file: null, covered: true};
  return {file: FAMILY[name] ?? kebab(name), covered: true};
}

export default function hazeCss(options: HazeCssOptions = {}): Plugin {
  const pkg = options.packageName ?? 'haze-ui';
  const tokensSpec = `${pkg}/css/tokens.css`;

  // 具名导入识别主路径交给 es-module-lexer（见 transform）：注释/字符串/
  // 模板/正则里的形似 import 天然不匹配，且直接给出语句区间与模块名；
  // lexer 解析失败时降级为 stripComments + 正则扫描（同文件头「运行阶段」）。

  // dev server 的根相对 id（如 '/src/App.tsx'）不是磁盘路径时，按
  // config.root 补全；configResolved 未跑（如测试直调）时退回 cwd。
  let root = process.cwd();

  return {
    name: 'vite-plugin-haze-ui:haze-css',
    // 不设 enforce：normal 顺序保证运行在 vite 内置 TS/JSX 转换之后
    //（运行阶段契约见文件头注释）。
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      const q = id.indexOf('?');
      const raw = q === -1 ? id : id.slice(0, q);
      // 按路径段判 node_modules（子串判断会把 'workspace-node_modules-x'
      // 这类正常源码目录误杀）
      if (id.startsWith('\0') || raw.split(/[\\/]/).includes('node_modules')) return null;
      // js/jsx/ts/tsx + mjs/mts/cjs/cts；vue sfc、css 等交给别的插件
      if (!/\.[cm]?[jt]sx?$/.test(raw)) return null;

      // dev 根相对 id（如 '/src/App.tsx'）不是磁盘路径时按 config.root
      // 拼接（join 不做绝对段重置）；绝对路径 resolve 恒等，相对路径
      // resolve 等价 join(root, raw)。
      const file =
        isAbsolute(raw) && !fs.existsSync(raw)
          ? join(root, raw)
          : resolve(root, raw);

      // es-module-lexer 词法识别：字符串里的伪 import 不再误注入，'//' 在
      // 字符串/正则里也不再吞掉同行的真实 import（旧 stripComments 的
      // 两类缺陷同时消除）。lexer 对原始 JSX/未知新语法会抛 ParseError——
      // 正常管线里到达本插件时已是纯 ESM JS（见文件头「运行阶段」），
      // 唯一例外（tsconfig "jsx": "preserve" 的 vite 5–7）降级为正则扫描。
      let imports: readonly Import[];
      let lexed = true;
      try {
        [imports] = parse(code, id);
      } catch (e) {
        this.warn(
          `[vite-plugin-haze-ui] ${file}：es-module-lexer 无法解析该模块` +
            `（${e instanceof Error ? e.message : String(e)}），降级为正则扫描。` +
            '字符串/注释里的形似 import 文本可能被误注入。'
        );
        lexed = false;
        imports = [];
      }

      let namespace = false;
      const names = new Set<string>();
      if (lexed) {
        for (const im of imports) {
          if (im.type !== 'static' || im.typeOnly || im.specifier !== pkg)
            continue;
          const stmt = code.slice(im.importStart, im.importEnd);
          // export {X} from / export * from 'haze-ui'（lexer 会列入）不收集：
          // 文档化边界（转发不注入）
          if (stmt.startsWith('export')) continue;
          if (/^import\s*\*/.test(stmt)) {
            namespace = true;
            continue;
          }
          const body = bracedSpecs(stmt);
          if (body === null) continue; // 纯 default / 副作用导入
          addSpecs(names, body);
        }
      } else {
        const clean = stripComments(code);
        const namedRe = new RegExp(
          `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(pkg)}['"]`,
          'g'
        );
        for (const m of clean.matchAll(namedRe)) {
          if (m[1] !== undefined) addSpecs(names, m[1]);
        }
        if (
          new RegExp(
            `import\\s*\\*\\s*as\\s+\\w+\\s*from\\s*['"]${escapeRegExp(pkg)}['"]`
          ).test(clean)
        ) {
          namespace = true;
        }
      }
      if (namespace) {
        this.warn(
          `[vite-plugin-haze-ui] ${file} 使用了 \`import * as … from '${pkg}'\`：` +
            '命名空间导入收集不到具名组件，无法按需注入 css。' +
            `请改为具名导入（import {Button} from "${pkg}"）。`
        );
      }
      if (names.size === 0) return null;

      if (!fs.existsSync(file)) {
        // 无 \0 前缀的虚拟模块等：没有磁盘基准，注入必然落到错误副本
        this.warn(
          `[vite-plugin-haze-ui] 模块 id ${id} 无法定位到磁盘文件（${file} 不存在），跳过注入。`
        );
        return null;
      }

      // 解析基准 = 导入方文件（独立包正确性的核心，见文件头注释）
      const req = requireOf(file);
      let install: Install;
      try {
        install = installOf(req, pkg);
      } catch (e) {
        this.error(
          `[vite-plugin-haze-ui] ${file} 内发现对 ${pkg} 的具名导入，但无法从该文件` +
            `解析 ${tokensSpec}（${e instanceof Error ? e.message : String(e)}）。` +
            `请确认 ${pkg} 已安装在该文件可解析的 node_modules 链上。`
        );
      }

      const manifest = manifestOf(install);
      if (manifest.kind === 'broken') {
        this.error(`[vite-plugin-haze-ui] ${manifest.problem}`);
      }

      // fail-fast 报错四要素：触发注入的源文件、具名导入名、期望 css
      // 路径、修复提示。gap = manifest 在场但该导出未被其覆盖。
      const missingCss = (name: string, spec: string, gap: boolean) =>
        `[vite-plugin-haze-ui] 源文件 ${file} 的 \`import {${name}} from '${pkg}'\` ` +
        `无法注入样式：期望的 ${spec} 在该文件解析到的 ${pkg} 内不存在` +
        `（css 目录：${install.cssDir}）。` +
        (gap
          ? `该导出在 ${pkg} 的 css-manifest.json（families/noCss）中未列出。`
          : '') +
        `修复：升级 ${pkg}（新版本可能已含该 css 或已在 manifest 登记），` +
        '或对 vite-plugin-haze-ui 上报映射缺口（manifest 缺席时为 FAMILY/NO_CSS 表）。';

      const specs = [
        tokensSpec,
        ...[...names]
          .map((n) => {
            const {file: base, covered} = cssFileOf(n, manifest);
            if (base === null) return null;
            const spec = `${pkg}/css/${base}.css`;
            if (!covered) this.error(missingCss(n, spec, true));
            try {
              resolveCss(req, install, spec);
            } catch (e) {
              // 附上原始解析错误（如 ERR_PACKAGE_PATH_NOT_EXPORTED：
              // 文件在但 exports 未暴露 ./css/*），区分「文件不存在」与
              // 「解析受阻」两类根因；node 的 code 在 e.code 上而非
              // message 内，一并拼入便于检索
              let detail = '';
              if (e instanceof Error && e.message) {
                const code = 'code' in e && typeof e.code === 'string' ? e.code : null;
                detail = code === null ? e.message : `${code}: ${e.message}`;
              }
              this.error(
                missingCss(n, spec, false) + (detail ? `\n原因：${detail}` : '')
              );
            }
            return spec;
          })
          .filter((spec): spec is string => spec !== null)
          // 家族映射令多个组件同落一个 css（Title/Text→typography），按
          // 文件去重——dev 下重复 import 会让浏览器重复加载同一文件
          .filter((spec, i, arr) => arr.indexOf(spec) === i)
      ];

      const inject = specs.map((s) => `import ${JSON.stringify(s)};`).join('\n');
      return `${inject}\n${code}`;
    }
  };
}

export {hazeCss};
