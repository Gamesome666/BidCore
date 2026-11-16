// 版式要求解析：从招标文件正文里读出「正文用什么字体、多大字号、几倍行距、页边距多少、要不要页码」，
// 供 docx 生成器按招标要求排版（原来生成器用的是写死的默认值，格式是否合规只能靠人眼）。
// 只做确定性正则抽取，不进模型，抽不到就返回 found=false，生成器回落到默认版式。

const HALF_POINT = {
  初号: 84, 小初: 72, 一号: 52, 小一: 48, 二号: 44, 小二: 36,
  三号: 32, 小三: 30, 四号: 28, 小四: 24, 五号: 21, 小五: 18,
};

const FONT_NAMES = ['仿宋_GB2312', '仿宋', '宋体', '黑体', '楷体', '微软雅黑', '思源宋体', '方正小标宋'];

/** 1 厘米 = 567 twips（1440 ÷ 2.54），Word 页边距单位是 twip */
const CM_TO_TWIP = 566.93;
const MM_TO_TWIP = 56.693;

function toTwip(value, unit) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (unit === 'mm' || unit === '毫米') return Math.round(num * MM_TO_TWIP);
  if (unit === 'cm' || unit === '厘米') return Math.round(num * CM_TO_TWIP);
  if (unit === '磅' || unit === 'pt') return Math.round(num * 20);
  return null;
}

/**
 * 从招标文本里解析版式要求。
 * @returns {{found:boolean, bodyFont?:string, bodySize?:number, line?:number, lineRule?:string,
 *            margins?:{top?:number,right?:number,bottom?:number,left?:number}, pageNumber?:boolean,
 *            evidence:string[]}}
 */
export function parseLayoutSpec(text) {
  const src = String(text || '');
  const result = { found: false, evidence: [] };
  if (!src) return result;

  // 字体：必须有「正文/投标文件/字体」这类引导词，避免把随机出现的字体名当成正文要求
  const bodyFontMatch =
    new RegExp(`(?:正文|投标文件|方案正文)[^。；\\n]{0,30}?(${FONT_NAMES.join('|')})`).exec(src)
    || new RegExp(`(?:字体|字型)[^。；\\n]{0,12}?(${FONT_NAMES.join('|')})`).exec(src);
  if (bodyFontMatch) {
    const name = bodyFontMatch[1] || bodyFontMatch[0];
    result.bodyFont = name;
    result.evidence.push(`字体：${name}`);
  }

  // 字号：同样必须有引导词；且排除「大小一致」这类把「小一」当字号的情况（后面紧跟「致」不算）
  const SIZE_WORDS = '初号|小初|一号|小一|二号|小二|三号|小三|四号|小四|五号|小五';
  const sizeNearBody = new RegExp(`(?:正文|文字|字体)[^。；\\n]{0,12}?(${SIZE_WORDS})(?!致)`).exec(src);
  const sizeGuided = new RegExp(`(?:字号|字大小|采用|统一|全部|均使用|使用)[^。；\\n]{0,10}?(${SIZE_WORDS})(?!致)`).exec(src);
  const sizeMatch = sizeNearBody || sizeGuided;
  if (sizeMatch) {
    const key = sizeMatch[1];
    result.bodySize = HALF_POINT[key];
    result.evidence.push(`字号：${key}（${HALF_POINT[key] / 2}pt）`);
  }

  // 行距：倍数（1.5 倍 / 2 倍）或固定值（28 磅）
  const lineTimes = /行距[^。；\n]{0,8}?(\d+(?:\.\d+)?)\s*倍/.exec(src) || /(\d+(?:\.\d+)?)\s*倍行距/.exec(src);
  if (lineTimes) {
    result.line = Math.round(Number(lineTimes[1]) * 240);
    result.lineRule = 'auto';
    result.evidence.push(`行距：${lineTimes[1]} 倍`);
  } else {
    const lineFixed = /行距[^。；\n]{0,8}?固定值\s*(\d+(?:\.\d+)?)\s*磅/.exec(src);
    if (lineFixed) {
      result.line = Math.round(Number(lineFixed[1]) * 20);
      result.lineRule = 'exact';
      result.evidence.push(`行距：固定值 ${lineFixed[1]} 磅`);
    }
  }

  // 页边距：上下左右可分别取，也可只给一个统一值
  const margins = {};
  const sideMap = { 上: 'top', 下: 'bottom', 左: 'left', 右: 'right' };
  const sideRe = /(上|下|左|右)\s*(?:边距)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(厘米|cm|毫米|mm)/g;
  let side;
  while ((side = sideRe.exec(src)) !== null) {
    margins[sideMap[side[1]]] = toTwip(side[2], side[3]);
  }
  if (Object.keys(margins).length) {
    result.margins = margins;
    result.evidence.push(`页边距：${Object.entries(margins).map(([k, v]) => `${k} ${(v / CM_TO_TWIP).toFixed(2)}cm`).join(' / ')}`);
  } else {
    const uniform = /页边距[^。；\n]{0,6}?(\d+(?:\.\d+)?)\s*(厘米|cm|毫米|mm)/.exec(src);
    if (uniform) {
      const twip = toTwip(uniform[1], uniform[2]);
      result.margins = { top: twip, right: twip, bottom: twip, left: twip };
      result.evidence.push(`页边距：四边 ${uniform[1]}${uniform[2]}`);
    }
  }

  // 页码：只认"页脚/页底/居中"上下文里出现的页码字样，避免把"页码编码规则"之类误判
  if (/(页脚|页底)[^。；\n]{0,12}(页码)|页码[^。；\n]{0,8}(页脚|页底|居中)/.test(src)) {
    result.pageNumber = true;
    result.evidence.push('页码：页脚');
  }

  result.found = Boolean(result.bodyFont || result.bodySize || result.line || result.margins || result.pageNumber);
  return result;
}

/** 从 tender.format 产物里取版式（format 节点会把 layout 一起存下来） */
export function layoutFromFormat(formatArtifact) {
  const layout = formatArtifact?.layout;
  if (!layout || !layout.found) return null;
  return layout;
}
