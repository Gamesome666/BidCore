// 商务/资格证据链：把企业知识库里的资质证书、业绩合同、人员证书，逐条匹配到招标文件的
// 「第三章 资格审查」条款上，产出「要求 → 证明材料 → 证书编号 → 有效期 → 判定」对照表。
// 只读知识库，不改知识库；export 步骤把结果写进 project_state.qualification_pack，
// 并把引用回写到目录节点的 refs.knowledge（资格 / 业绩 / 人员 三个节点）。
import { all } from '../db.mjs';
import { clip, nowIso } from '../lib/util.mjs';
import { extractQualificationClauses } from './tenderSections.mjs';

const QUAL_RE = /ISO\s?\d{3,5}|ITSS|CMMI|信息安全|等保|资质|认证|许可证|营业执照|软著|著作权/i;
const PERF_RE = /业绩|中标|验收|合同|案例/;
const PERSON_RE = /项目经理|系统工程师|技术负责人|人员|PMP|RHCE|职称|执业资格/;

// 证书/合同文号：知识库里的正文既可能是「证书编号：X」，也可能是上传后解析成「证书编号 | X」
const SEP = '[：:|｜\\s]*';
const CERT_NO_RE = new RegExp(`(?:证书编号|证书号|注册号)${SEP}([A-Za-z0-9][A-Za-z0-9\\-]{3,})`);
const CONTRACT_NO_RE = new RegExp(`(?:合同编号|中标编号|招标编号|项目编号|备案号)${SEP}([A-Za-z0-9][A-Za-z0-9\\-]{3,})`);
const GENERIC_NO_RE = /\b([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+){1,})\b/;
const AMOUNT_RE = /([\d,]+(?:\.\d+)?)\s*万元/;
// 「有效期 | 2024 年 6 月 18 日 至 2027 年 6 月 17 日」/「有效期至 2027-06-17」都取到期日
const EXPIRY_RANGE_RE = /有效期[^0-9]{0,14}(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^0-9]{0,10}(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
const EXPIRY_RE = /有效期[^0-9]{0,10}(\d{4}\s*[-年./]\s*\d{1,2}\s*[-月./]\s*\d{1,2})/;
const PERSON_TITLE_RE = /(?:项目经理|系统工程师|技术负责人|工程师|架构师)[\s·:：]*([\u4e00-\u9fa5]{2,4})/;
const CERT_TOKEN_RE = /PMP|RHCE|RHCSA|信息系统项目管理师|系统集成项目管理工程师|软件设计师|数据库系统工程师|达梦\s?DCP|麒麟[^\s，。；、|]*|鲲鹏[^\s，。；、|]*|CCNP|HCIE|OCP/g;
const RUANKAO_RE = /软件设计师|系统集成项目管理工程师|数据库系统工程师|信息系统项目管理师/;

/** Markdown 表格单元格：竖线/换行会破坏表格 */
function cell(value, max = 80) {
  return clip(String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim(), max) || '—';
}

function classify(doc) {
  const title = String(doc.title || '');
  const content = String(doc.content || '');
  if (PERF_RE.test(title)) return 'perf';
  if (doc.library === 'personnel' || PERSON_RE.test(title)) return 'person';
  if (QUAL_RE.test(title) || QUAL_RE.test(content)) return 'qual';
  return null;
}

function extractCertNo(doc) {
  const text = `${doc.title || ''}\n${doc.content || ''}`;
  return (CERT_NO_RE.exec(text)?.[1] || GENERIC_NO_RE.exec(text)?.[1] || '').trim();
}

function extractExpiry(doc) {
  const text = String(doc.content || '');
  const range = EXPIRY_RANGE_RE.exec(text);
  if (range) {
    const [, , , , y, m, d] = range;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (doc.expires_at) return String(doc.expires_at).slice(0, 10);
  return (EXPIRY_RE.exec(text)?.[1] || '').replace(/[年月]/g, '-').replace(/日/, '').replace(/\s/g, '');
}

function extractPerson(doc) {
  const title = String(doc.title || '');
  const fromTitle = PERSON_TITLE_RE.exec(title)?.[1];
  if (fromTitle) return fromTitle;
  const parts = title.split(/[_·|]/).map((s) => s.trim()).filter(Boolean);
  const tail = parts.at(-1) || '';
  return /^[\u4e00-\u9fa5]{2,4}$/.test(tail) ? tail : title;
}

function extractRole(doc) {
  return /(项目经理|系统工程师|技术负责人|架构师|工程师)/.exec(String(doc.title || ''))?.[1]
    || (doc.library === 'personnel' ? '项目成员' : '');
}

function extractCerts(doc) {
  const text = `${doc.title || ''} ${doc.content || ''}`;
  return [...new Set(text.match(CERT_TOKEN_RE) || [])].slice(0, 4);
}

/** 招标文件「资格审查」里的 3.1 一般资格 / 3.2 特定资格条款（不依赖章号，按标题语义定位） */
function extractClauses(tenderText) {
  const { general, specific } = extractQualificationClauses(tenderText);
  return { general, specific };
}

/** 条款 → 知识库匹配 */
function matchClause(clause, buckets) {
  const text = `${clause.requirement} ${clause.evidence} ${clause.attribute}`;
  const threshold = Number(/不低于\s*([\d.]+)\s*万元/.exec(text)?.[1] || 0);
  const headcount = Number(/不少于\s*(\d+)\s*人/.exec(text)?.[1] || 0);

  // 原厂授权函：制造商文件，知识库里不会有
  if (/原厂授权函|经销协议/.test(text)) {
    return { status: 'gap', docs: [], note: '需向制造商索取《原厂授权函》原件扫描件，知识库无此类外部文件' };
  }

  // 业绩类
  if (/业绩|合同关键页|验收报告/.test(text) && /万元|项目/.test(text)) {
    const qualified = buckets.perf.filter((p) => (threshold ? p.amountValue >= threshold : true));
    if (!qualified.length) {
      return { status: 'gap', docs: [], note: threshold ? `知识库无合同额 ≥ ${threshold} 万元的业绩` : '知识库无业绩记录' };
    }
    return { status: 'met', docs: qualified.map((p) => p.doc), note: `${qualified.length} 项符合` };
  }

  // 团队人数类
  if (/不少于|人员/.test(text) && /人/.test(text)) {
    const holders = buckets.person.filter((p) => p.certs.some((c) => RUANKAO_RE.test(c)));
    if (headcount && holders.length < headcount) {
      return { status: holders.length ? 'partial' : 'gap', docs: holders.map((p) => p.doc), note: `知识库仅 ${holders.length} 人持软考类证书，要求 ${headcount} 人` };
    }
    if (holders.length) return { status: 'met', docs: holders.map((p) => p.doc), note: `${holders.length} 人符合` };
  }

  // 项目经理类
  if (/项目经理/.test(text)) {
    const holders = buckets.person.filter((p) => p.certs.some((c) => /PMP|信息系统项目管理师/.test(c)));
    if (holders.length) return { status: 'met', docs: holders.map((p) => p.doc), note: `${holders.length} 人持 PMP / 高项证书` };
    return { status: 'gap', docs: [], note: '知识库无 PMP 或信息系统项目管理师持证人员' };
  }

  // 证书类：按令牌命中打分
  const tokens = [...new Set((text.match(/CCRC|信息安全服务资质|ITSS|ISO\s?\/?\s?IEC\s?27001|ISO\s?27001|ISO\s?9001|CMMI|营业执照|软件著作权/gi) || [])
    .map((s) => s.replace(/\s+/g, '').toUpperCase()))];
  if (tokens.length) {
    const ranked = buckets.qual
      .map((doc) => {
        const hay = `${doc.title} ${doc.content}`.replace(/\s+/g, '').toUpperCase();
        return { doc, score: tokens.reduce((sum, t) => (hay.includes(t) ? sum + 1 : sum), 0) };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length) return { status: 'met', docs: ranked.map((r) => r.doc), note: `${ranked[0].score} 个关键词命中` };
    return { status: 'gap', docs: [], note: `知识库无 ${tokens.join('/')} 对应证书` };
  }

  return { status: 'gap', docs: [], note: '需人工补充证明材料' };
}

/**
 * 生成商务资格证据包。
 * @param {{ project: object, state: object }} input
 */
export function buildQualificationPack({ project = {}, state = {}, compact = false }) {
  const docs = all('SELECT id, title, library, category, folder, content, expires_at FROM knowledge_docs');
  const buckets = { qual: [], perf: [], person: [] };
  for (const doc of docs) {
    const kind = classify(doc);
    if (kind) buckets[kind].push(doc);
  }

  const performance = buckets.perf.map((doc) => {
    const amountText = AMOUNT_RE.exec(String(doc.content || ''))?.[1] || '';
    return {
      doc,
      title: doc.title,
      contract_no: (CONTRACT_NO_RE.exec(String(doc.content || ''))?.[1] || extractCertNo(doc) || '').trim(),
      amount: amountText ? `${amountText} 万元` : '',
      amountValue: Number(amountText.replace(/,/g, '')) || 0,
      year: /(20\d{2})/.exec(`${doc.title} ${doc.content}`)?.[1] || '',
    };
  });

  const personnel = buckets.person.map((doc) => ({
    doc,
    name: extractPerson(doc),
    role: extractRole(doc),
    certs: extractCerts(doc),
    cert_no: extractCertNo(doc),
    expires_at: extractExpiry(doc),
  }));

  const { general, specific } = extractClauses(state.tender_text || project.tender_text || '');
  const matchBuckets = { qual: buckets.qual, perf: performance, person: personnel };
  const rows = specific.map((clause) => ({
    ...clause,
    ...matchClause(clause, matchBuckets),
  }));
  const generalRows = general.map((clause) => ({
    ...clause,
    ...matchClause(clause, matchBuckets),
  }));

  const met = rows.filter((r) => r.status === 'met').length;
  const partial = rows.filter((r) => r.status === 'partial').length;
  const gaps = rows.filter((r) => r.status === 'gap').length;
  const refTitles = [...new Set([
    ...rows.flatMap((r) => r.docs.map((d) => d.title)),
    ...generalRows.flatMap((r) => r.docs.map((d) => d.title)),
    ...performance.map((p) => p.doc.title),
    ...personnel.map((p) => p.doc.title),
  ])];

  const summary = {
    clauses: specific.length,
    met,
    partial,
    gaps,
    performance: performance.length,
    personnel: personnel.length,
    refs: refTitles,
    generated_at: nowIso(),
  };

  const statusText = { met: '满足', partial: '部分满足', gap: '缺口' };
  const lines = [];
  lines.push('## 附录C 商务资格与证明材料（知识库引用）');
  lines.push('');
  if (rows.length) {
    lines.push(`引用企业知识库 ${refTitles.length} 条；特定资格 ${specific.length} 条：满足 ${met}、部分满足 ${partial}、缺口 ${gaps}。`);
  } else {
    lines.push(`引用企业知识库 ${refTitles.length} 条；招标文件未解析到「第三章 3.2 特定资格」条款，按知识库分类列出可用证明材料。`);
  }
  lines.push('');

  if (rows.length) {
    lines.push('### C.1 特定资格逐条响应对照表');
    lines.push('');
    lines.push('| 条款 | 资格要求（招标文件） | 证明材料（知识库） | 证书编号 | 有效期 | 判定 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const doc = row.docs[0];
      lines.push(`| ${row.clause}${row.attribute?.includes('★') ? ' ★' : ''} | ${cell(row.requirement, 96)} | ${doc ? cell(doc.title, 40) : '—'} | ${cell(doc ? extractCertNo(doc) : '')} | ${cell(doc ? extractExpiry(doc) : '')} | ${statusText[row.status]} |`);
    }
    lines.push('');
  } else {
    // 兜底：招标正文里没有结构化资格条款时，直接把企业资质清单列出来，评审仍能看到证书编号
    lines.push('### C.1 企业资质证书清单');
    lines.push('');
    const credentialRows = buckets.qual.map((doc) => {
      const expiresAt = extractExpiry(doc);
      const ts = expiresAt ? new Date(expiresAt).getTime() : 0;
      const days = ts ? Math.ceil((ts - Date.now()) / 86400000) : null;
      const status = days === null ? '长期/未标注' : days < 0 ? `已过期 ${Math.abs(days)} 天` : days <= 45 ? `${days} 天后到期` : '有效';
      return { doc, certNo: extractCertNo(doc), expiresAt, status };
    });
    if (credentialRows.length) {
      lines.push('| 序号 | 资质 / 证书 | 证书编号 | 有效期 | 状态 |');
      lines.push('| --- | --- | --- | --- | --- |');
      credentialRows.forEach((row, index) => {
        lines.push(`| ${index + 1} | ${cell(row.doc.title, 46)} | ${cell(row.certNo || '—')} | ${cell(row.expiresAt || '—')} | ${cell(row.status, 20)} |`);
      });
    } else {
      lines.push('知识库中还没有资质类证书，请先上传营业执照、体系认证等扫描件。');
    }
    lines.push('');
  }

  if (!compact && generalRows.length) {
    lines.push('### C.2 一般资格（3.1）');
    lines.push('');
    lines.push('| 条款 | 要求 | 证明材料（知识库） | 判定 |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of generalRows) {
      lines.push(`| ${row.clause} | ${cell(row.requirement, 92)} | ${row.docs[0] ? cell(row.docs[0].title, 34) : '需提供原件扫描件'} | ${row.status === 'met' ? '已有' : '待补'} |`);
    }
    lines.push('');
  }

  if (!compact && performance.length) {
    lines.push('### C.3 同类业绩证明');
    lines.push('');
    lines.push('| 序号 | 业绩 / 证明材料 | 合同或中标编号 | 合同金额 | 年度 |');
    lines.push('| --- | --- | --- | --- | --- |');
    performance.forEach((item, index) => {
      lines.push(`| ${index + 1} | ${cell(item.title, 46)} | ${cell(item.contract_no)} | ${cell(item.amount)} | ${cell(item.year)} |`);
    });
    lines.push('');
  }

  if (!compact && personnel.length) {
    lines.push('### C.4 项目团队与人员资质');
    lines.push('');
    lines.push('| 姓名 | 岗位 | 证书 | 证书编号 / 有效期 |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of personnel) {
      const tail = [item.cert_no, item.expires_at].filter(Boolean).join(' / ') || '—';
      lines.push(`| ${cell(item.name, 12)} | ${cell(item.role || '—', 12)} | ${cell(item.certs.join('、') || '—', 40)} | ${cell(tail)} |`);
    }
    lines.push('');
  }

  const openRows = rows.filter((r) => r.status !== 'met');
  if (openRows.length) {
    lines.push(compact ? '### C.2 待补充事项（会影响资格审查）' : '### C.5 待补充事项（会影响资格审查）');
    lines.push('');
    for (const row of openRows) {
      lines.push(`- **${row.clause}** ${cell(row.requirement, 80)} —— ${row.note}。`);
    }
    lines.push('');
  }

  if (compact && refTitles.length) {
    lines.push('### C.3 证据来源');
    lines.push('');
    lines.push(`以上材料取自企业知识库 ${refTitles.length} 份文件：${refTitles.slice(0, 12).join('、')}${refTitles.length > 12 ? ' 等' : ''}。原件按招标文件要求编入投标文件相应章节。`);
    lines.push('');
  }

  return {
    markdown: lines.join('\n'),
    summary,
    refs: {
      qualifications: rows.filter((r) => r.status === 'met' && r.docs[0]).map((r) => r.docs[0].title),
      performance: performance.map((p) => p.doc.title),
      personnel: personnel.map((p) => p.doc.title),
    },
    rows,
    performance,
    personnel,
    credentials: buckets.qual.map((doc) => ({
      doc,
      certNo: extractCertNo(doc),
      expiresAt: extractExpiry(doc),
    })),
  };
}

/** 把知识库引用回写到目录节点（refs.knowledge），供前端角标与审计使用 */
export function attachKnowledgeRefs(outline, refs) {
  const nodes = outline?.nodes || [];
  const pick = (node) => {
    if (/资格/.test(node.title)) return refs.qualifications;
    if (/业绩/.test(node.title)) return refs.performance;
    if (/团队|人员|驻场/.test(node.title)) return refs.personnel;
    return null;
  };
  for (const node of nodes) {
    const knowledge = pick(node);
    if (!knowledge?.length) continue;
    node.refs = { ...(node.refs || {}), knowledge: [...new Set(knowledge)].slice(0, 12) };
  }
  return outline;
}
