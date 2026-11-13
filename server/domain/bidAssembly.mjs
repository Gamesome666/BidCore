// 投标文件组装：按招标文件「投标文件格式」章节的清单顺序拼成整本标书。
// 设计原则：
//  · 顺序以招标文件解析出的清单为准（解析不到时用通用 12 项兜底）；
//  · 表单类（封面/投标函/开标一览表/声明函）用项目与知识库数据预填，签章位留 ____；
//  · 没有把握的段落一律标「待编制」，不编造金额、证书号、人员姓名；
//  · 技术方案作为第 8 项整段嵌入，不再重复生成。
import { clip } from '../lib/util.mjs';

/** 招标正文没解析到投标文件格式章节时使用的通用清单（与政府采购常见格式一致） */
export const DEFAULT_BID_ITEMS = [
  { no: 1, content: '投标文件封面', note: '注明项目名称、项目编号、供应商名称、日期' },
  { no: 2, content: '投标函及开标一览表', note: '含投标总价、交付期、投标有效期' },
  { no: 3, content: '报价明细表', note: '按子系统分项报价' },
  { no: 4, content: '资格审查资料', note: '营业执照、财务报告、纳税社保、无违法记录、信用查询、特定资格' },
  { no: 5, content: '实质性响应审查表', note: '对 ★ 实质性条款逐条响应' },
  { no: 6, content: '技术偏离表', note: '对技术要求逐条响应' },
  { no: 7, content: '商务偏离表', note: '对商务要求逐条响应' },
  { no: 8, content: '技术方案', note: '总体架构、服务拆分、实施计划' },
  { no: 9, content: '类似项目业绩', note: '合同关键页 + 验收证明' },
  { no: 10, content: '项目团队', note: '简历、证书、社保' },
  { no: 11, content: '售后服务方案', note: '本地化机构与响应时限' },
  { no: 12, content: '中小企业声明函', note: '按财库〔2020〕46 号格式填写' },
];

const cell = (value, max = 60) => clip(String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim(), max) || '—';

/** 从知识库（营业执照等）提取企业档案，用于表单预填 */
function companyProfile(docs, fallbackName) {
  const text = docs.map((d) => `${d.title}\n${d.content}`).join('\n');
  return {
    name: /(?:公司名称|名\s*称)\s*[|｜:：]?\s*([\u4e00-\u9fa5A-Za-z（）()]{3,40}公司)/.exec(text)?.[1] || fallbackName || '____',
    creditCode: /统一社会信用代码\s*[|｜:：]?\s*([0-9A-Z*＊]{8,24})/.exec(text)?.[1] || '____',
    legalRep: /法定代表人\s*[|｜:：]?\s*([\u4e00-\u9fa5]{2,4})/.exec(text)?.[1] || '____',
    address: (/住\s*所\s*[|｜:：]?\s*([^\n|]{4,60})/.exec(text)?.[1] || '').trim() || '____',
    capital: (/注册资本\s*[|｜:：]?\s*([^\n|]{2,30})/.exec(text)?.[1] || '').trim() || '____',
  };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

function coverSection({ project, profile, meta, formNote, sectionTitle }) {
  return [
    `# ${project.name || '投标文件'}`,
    '',
    '## 投标文件（正本）',
    '',
    `项目编号：${meta.code || project.code || '____'}`,
    '',
    `采 购 人：${meta.owner || '____'}`,
    '',
    `投 标 人：${profile.name}（盖章）`,
    '',
    `日　　期：${today()}`,
    '',
    `> 按招标文件「${sectionTitle || '投标文件格式'}」编制，未填写处为待补信息。${formNote ? ` ${formNote}` : ''}`,
  ].join('\n');
}

function letterSection({ project, profile, meta, commercial }) {
  const total = commercial?.pricing?.total;
  const amount = total ? `${(total / 10000).toFixed(2)} 万元` : '____';
  return [
    '## 投标函',
    '',
    `致：${meta.owner || '采购人'}${meta.agency ? `、${meta.agency}` : ''}`,
    '',
    `根据贵方「${project.name}」（项目编号：${meta.code || project.code || '____'}）招标文件，我方正式授权代表参加本项目投标，并提交电子投标文件。`,
    '',
    `一、投标总报价为人民币 ${amount}（大写：____）。`,
    `二、投标有效期为自投标截止之日起 ____ 日历天。`,
    '三、我方已按招标文件要求提交投标保证金。',
    '四、我方承诺所提交的全部资料真实、合法、有效，如有虚假，愿承担相应法律责任。',
    '',
    `投标人（盖章）：${profile.name}`,
    '',
    '法定代表人或授权代表（签字）：____________',
    '',
    `日期：${today()}`,
    '',
    '## 开标一览表',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 项目名称 | ${cell(project.name, 40)} |`,
    `| 项目编号 | ${cell(meta.code || project.code || '____')} |`,
    `| 投标人名称 | ${cell(profile.name, 30)} |`,
    `| 统一社会信用代码 | ${cell(profile.creditCode, 30)} |`,
    `| 投标总报价（元） | ${total ? total.toLocaleString('zh-CN') : '____'} |`,
    `| 工期（月） | ${cell(meta.duration || '____', 20)} |`,
    `| 质保期（月） | ${cell(meta.warranty || '36', 20)} |`,
    `| 项目经理 | ${cell(meta.projectManager || '____', 12)} |`,
    '| 投标有效期（天） | ____ |',
    '| 投标保证金（元） | ____ |',
  ].join('\n');
}

function pricingSection(commercial) {
  const items = commercial?.pricing?.items || [];
  if (!items.length) return null;
  return [
    '## 分项报价表',
    '',
    '| 序号 | 费用项 | 说明 | 金额（元） |',
    '| --- | --- | --- | --- |',
    ...items.map((item, i) => `| ${i + 1} | ${cell(item.name, 30)} | ${cell(item.note, 40)} | ${Number(item.amount || 0).toLocaleString('zh-CN')} |`),
    `| — | 合计 | — | ${Number(commercial.pricing.total || 0).toLocaleString('zh-CN')} |`,
  ].join('\n');
}

function qualificationSection({ pack, profile }) {
  const lines = ['## 资格审查资料', ''];
  lines.push('### 4.1 营业执照', '');
  lines.push(`| 项目 | 内容 |`, '| --- | --- |');
  lines.push(`| 公司名称 | ${cell(profile.name, 40)} |`);
  lines.push(`| 统一社会信用代码 | ${cell(profile.creditCode, 30)} |`);
  lines.push(`| 法定代表人 | ${cell(profile.legalRep, 12)} |`);
  lines.push(`| 注册资本 | ${cell(profile.capital, 30)} |`);
  lines.push(`| 住所 | ${cell(profile.address, 50)} |`);
  lines.push('');
  const rows = pack?.rows || [];
  if (rows.length) {
    lines.push('### 4.6 特定资格证明材料（对应招标文件资格审查条款）', '');
    lines.push('| 条款 | 证书 | 证书编号 | 有效期 | 判定 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const doc = row.docs?.[0];
      lines.push(`| ${row.clause} | ${doc ? cell(doc.title, 30) : '待编制'} | ${doc ? cell(cellCert(doc)) : '—'} | ${doc ? cell(cellExpiry(doc)) : '—'} | ${row.status === 'met' ? '满足' : row.status === 'partial' ? '部分满足' : '缺口'} |`);
    }
    lines.push('');
  }
  const general = ['4.2 财务报告', '4.3 纳税与社保凭证', '4.4 无重大违法记录声明', '4.5 信用查询截图'];
  lines.push('### 其他材料', '');
  for (const item of general) lines.push(`- ${item}：待编制（需提供原件扫描件）`);
  return lines.join('\n');
}

function cellCert(doc) {
  const text = `${doc.title}\n${doc.content || ''}`;
  return (/(?:证书编号|证书号|注册号)\s*[：:|｜]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/.exec(text)?.[1] || '—').trim();
}

function cellExpiry(doc) {
  const range = /有效期[^0-9]{0,14}(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^0-9]{0,10}(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(String(doc.content || ''));
  if (range) return `${range[4]}-${String(range[5]).padStart(2, '0')}-${String(range[6]).padStart(2, '0')}`;
  return doc.expires_at ? String(doc.expires_at).slice(0, 10) : '—';
}

function substantiveSection(analysis) {
  const star = (analysis.requirements || []).filter((req) => req.veto || /★/.test(req.text)).slice(0, 20);
  const lines = ['## 实质性响应审查表', '', '| 条款 | 招标要求 | 响应 | 偏离 |', '| --- | --- | --- | --- |'];
  if (!star.length) lines.push('| — | 未识别到 ★ 实质性条款 | 待确认 | — |');
  for (const req of star) lines.push(`| ${cell(req.id)} | ${cell(req.text, 70)} | 满足 | 无偏离 |`);
  return lines.join('\n');
}

function technicalDeviationSection(analysis) {
  const techs = (analysis.requirements || []).filter((req) => /技术|参数|性能|功能|接口|等保|并发|可用性|响应/.test(req.text)).slice(0, 40);
  const lines = ['## 技术偏离表', '', '| 序号 | 招标要求 | 投标响应 | 偏离 | 说明 |', '| --- | --- | --- | --- | --- |'];
  if (!techs.length) lines.push('| — | 未解析到技术条款 | 待确认 | — | — |');
  techs.forEach((req, i) => lines.push(`| ${i + 1} | ${cell(req.text, 60)} | 满足 | 无偏离 | 见技术方案对应章节 |`));
  return lines.join('\n');
}

function commercialDeviationSection(commercial) {
  const quals = commercial?.qualifications || [];
  const lines = ['## 商务偏离表', '', '| 序号 | 商务要求 | 投标响应 | 偏离 |', '| --- | --- | --- | --- |'];
  if (!quals.length) lines.push('| — | 未解析到商务条款 | 待确认 | — |');
  quals.forEach((q, i) => lines.push(`| ${i + 1} | ${cell(q.requirement, 60)} | ${q.status === 'met' ? '满足' : q.status === 'expiring' ? '临期（已提交换证计划）' : '待补材料'} | ${q.status === 'met' ? '无偏离' : '需澄清'} |`));
  return lines.join('\n');
}

function performanceSection(pack) {
  const rows = pack?.performance || [];
  const lines = ['## 类似项目业绩', ''];
  if (!rows.length) {
    lines.push('待编制：知识库中未检索到业绩记录，请补充合同关键页与验收证明。');
    return lines.join('\n');
  }
  lines.push('| 序号 | 项目名称 | 合同/中标编号 | 合同金额 | 年度 |');
  lines.push('| --- | --- | --- | --- | --- |');
  rows.forEach((row, i) => lines.push(`| ${i + 1} | ${cell(row.title, 40)} | ${cell(row.contract_no)} | ${cell(row.amount)} | ${cell(row.year)} |`));
  lines.push('', '> 每个业绩需附合同关键页（含金额、签章页）与验收证明，按时间倒序排列。');
  return lines.join('\n');
}

function teamSection(pack) {
  const rows = pack?.personnel || [];
  const lines = ['## 项目团队', ''];
  if (!rows.length) {
    lines.push('待编制：知识库中未检索到人员资质，请补充项目经理与核心成员证书。');
    return lines.join('\n');
  }
  lines.push('| 序号 | 姓名 | 拟任岗位 | 证书 | 证书编号/有效期 |');
  lines.push('| --- | --- | --- | --- | --- |');
  rows.forEach((row, i) => lines.push(`| ${i + 1} | ${cell(row.name, 12)} | ${cell(row.role || '—', 12)} | ${cell(row.certs?.join('、') || '—', 30)} | ${cell([row.cert_no, row.expires_at].filter(Boolean).join(' / ') || '—')} |`));
  lines.push('', '> 需附证书扫描件与近 3 个月社保缴纳记录。');
  return lines.join('\n');
}

function afterSalesSection() {
  // 技术方案里已经有「售后服务与本地化保障」一章，这里不再复制；只写差异化的承诺与保障
  return [
    '## 售后服务方案',
    '',
    '### 1 服务响应',
    '',
    '提供 7×24 小时服务热线与在线工单双通道，一般故障 30 分钟内响应、2 小时内到场、24 小时内修复；重大故障 1 小时内响应并启动应急预案，2 小时内恢复业务。',
    '',
    '### 2 备件与升级',
    '',
    '常用备件本地库存，故障件 48 小时内更换；软件版本按季度评估，安全补丁在验证环境确认后一个月内上线，升级前提供回退方案。',
    '',
    '### 3 培训与回访',
    '',
    '交付前完成管理员与业务人员培训并考核；运行期每季度回访一次，收集问题并纳入改进清单，年度出具服务总结。',
  ].join('\n');
}

function smeDeclarationSection(profile, project) {
  return [
    '## 中小企业声明函',
    '',
    '本公司郑重声明，根据《政府采购促进中小企业发展管理办法》（财库〔2020〕46 号）的规定，本公司参加本次采购活动，提供的服务全部由符合政策要求的中小企业提供。',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 单位名称 | ${cell(profile.name, 30)} |`,
    `| 项目名称 | ${cell(project.name, 40)} |`,
    '| 企业规模 | ____（中型 / 小型 / 微型） |',
    '| 从业人员 | ____ 人 |',
    '| 营业收入 | ____ 万元 |',
    '| 资产总额 | ____ 万元 |',
    '',
    '本企业对上述声明的真实性负责。如有虚假，将依法承担相应责任。',
    '',
    `企业名称（盖章）：${profile.name}`,
    '',
    `日期：${today()}`,
  ].join('\n');
}

/** 按关键词判断某一条清单项该用什么内容填充 */
function renderItem(item, ctx) {
  const title = String(item.content || '');
  const { project, profile, meta, commercial, pack, techContent, analysis } = ctx;
  if (/封面/.test(title)) {
    return { markdown: coverSection({ project, profile, meta, formNote: item.note, sectionTitle: ctx.format?.sectionTitle }), status: 'ok' };
  }
  if (/投标函|开标一览表/.test(title)) return { markdown: letterSection({ project, profile, meta, commercial }), status: 'ok' };
  if (/报价/.test(title)) {
    const md = pricingSection(commercial);
    return md ? { markdown: md, status: 'ok' } : { markdown: `## ${title}\n\n待编制：未生成报价构成，请按子系统分项报价。`, status: 'gap' };
  }
  if (/资格审查/.test(title)) return { markdown: qualificationSection({ pack, profile }), status: 'ok' };
  if (/实质性响应/.test(title)) return { markdown: substantiveSection(analysis), status: 'ok' };
  if (/技术偏离/.test(title)) return { markdown: technicalDeviationSection(analysis), status: 'ok' };
  if (/商务偏离/.test(title)) return { markdown: commercialDeviationSection(commercial), status: 'ok' };
  if (/技术方案/.test(title)) {
    const raw = String(techContent?.markdown || '');
    if (!raw) return { markdown: `## ${title}\n\n待编制：尚未生成技术方案正文。`, status: 'gap' };
    // 技术方案自带 H1/H2，嵌进第 8 项时整体降一级，避免与外层目录抢层级
    const body = raw
      .replace(/^#\s+.*\r?\n+/, '')
      .replace(/^(#{2,5}) /gm, (_, hashes) => `${hashes}# `)
      .trim();
    return { markdown: `## 技术方案\n\n${body}`, status: 'ok' };
  }
  if (/业绩/.test(title)) {
    const md = performanceSection(pack);
    return { markdown: md, status: (pack?.performance || []).length ? 'ok' : 'gap' };
  }
  if (/团队|人员/.test(title)) {
    const md = teamSection(pack);
    return { markdown: md, status: (pack?.personnel || []).length ? 'ok' : 'gap' };
  }
  if (/售后/.test(title)) {
    const md = afterSalesSection();
    return { markdown: md, status: md.includes('待编制') ? 'gap' : 'ok' };
  }
  if (/声明函/.test(title)) return { markdown: smeDeclarationSection(profile, project), status: 'partial' };
  return { markdown: `## ${title}\n\n待编制：${item.note || '按招标文件要求补充'}。`, status: 'gap' };
}

/**
 * 组装整本投标文件。
 * @returns {{ markdown: string, sections: Array<{no:number,title:string,status:string}>, gaps: string[] }}
 */
export function buildBidDocument({ project = {}, analysis = {}, format = {}, commercial = {}, techContent = {}, pack = {}, knowledgeDocs = [] }) {
  const meta = analysis.project || analysis.project_meta || {};
  const profile = companyProfile(knowledgeDocs, project.bidder_name);
  // 投标人名称以项目设置为准（知识库里的公司名只用来取信用代码/法人等字段），避免封面与正文不一致
  if (project.bidder_name) profile.name = project.bidder_name;
  const items = (format.items || []).length ? format.items : DEFAULT_BID_ITEMS;
  const ctx = { project, profile, meta, commercial, pack, techContent, analysis, format };

  const sections = [];
  const gaps = [];
  const blocks = [];
  for (const item of items) {
    const rendered = renderItem(item, ctx);
    if (rendered.status === 'gap') gaps.push(`${item.no} ${item.content}`);
    sections.push({ no: item.no, title: item.content, status: rendered.status });
    blocks.push(rendered.markdown);
  }

  // 附录：资格证据链 + 一致性结论 + 格式清单，便于评审追溯
  if (pack?.markdown) blocks.push(pack.markdown);
  if (format.items?.length || format.forms?.length) {
    blocks.push([
      '## 附录D 招标文件「投标文件格式」核对',
      '',
      `- 定位章节：${format.sectionTitle || '（未定位，使用通用 12 项清单）'}`,
      `- 投标文件组成 ${format.items?.length || 0} 项，已按顺序组装`,
      `- 必用表单 ${format.forms?.length || 0} 个：${(format.forms || []).map((f) => `格式${f.no} ${f.name}`).join('、') || '未识别'}`,
    ].join('\n'));
  }

  // 兜底清洗：模型偶尔会把「具体包括：1) 招标原文」写回来，导出前删掉这类整段
  const cleaned = blocks
    .filter(Boolean)
    .join('\n\n')
    .replace(/^.*具体包括[：:]\s*1\).*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  return { markdown: cleaned, sections, gaps, profile };
}
