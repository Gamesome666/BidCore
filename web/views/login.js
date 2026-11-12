// 登录页：左墨色品牌区 + 右表单。登录成功写入 token 后整页 reload，由外壳拉取会话。
import { api, store } from '../lib/api.js';
import { $, escapeHtml } from '../lib/ui.js';

const DEMO_ACCOUNTS = [
  ['admin', 'admin123', '管理员'],
  ['owner', 'owner123', '项目负责人'],
  ['tech', 'tech123', '技术负责人'],
  ['biz', 'biz123', '商务负责人'],
  ['reviewer', 'reviewer123', '审核员'],
];

const POINTS = [
  ['Supervisor', '按依赖与预算动态调度 Agent，计划可回放'],
  ['Human-in-the-Loop', '多级审核门禁，驳回必选上游返工目标'],
  ['Self-Loop', '五维质量门禁 + 定向返工，最多三轮迭代'],
  ['离线可用', '未配置模型时走确定性 Mock，链路完整'],
];

const STYLE = `
<style>
  #view:has(> .login-page) { padding: 0; max-width: none; }
  .lg-page { min-height: 100vh; display: grid; grid-template-columns: 1.06fr .94fr; background: var(--paper); }
  .lg-visual { background: var(--nav); color: #e9e5d9; padding: 46px 54px 40px; display: flex; flex-direction: column; position: relative; overflow: hidden; }
  .lg-visual::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
    background-size: 46px 46px;
  }
  .lg-brand { display: flex; align-items: center; gap: 11px; position: relative; z-index: 1; }
  .lg-brand .brand-mark { width: 38px; height: 38px; font-size: 21px; }
  .lg-brand strong { font-size: 15.5px; letter-spacing: .05em; color: #f4f1e8; display: block; }
  .lg-brand em { font-style: normal; font-size: 10.5px; color: var(--nav-muted); letter-spacing: .12em; }
  .lg-headline { font-family: var(--serif); font-size: 37px; line-height: 1.26; margin-top: auto; position: relative; z-index: 1; color: #f7f4ea; letter-spacing: .005em; }
  .lg-headline em { font-style: normal; color: #e8926c; }
  .lg-sub { color: #9fadb5; font-size: 13px; margin-top: 14px; max-width: 452px; line-height: 1.75; position: relative; z-index: 1; }
  .lg-points { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 20px; margin-top: 28px; position: relative; z-index: 1; }
  .lg-point { display: flex; gap: 8px; font-size: 11.8px; color: #b9c4c9; line-height: 1.55; }
  .lg-point i { color: #e8926c; font-style: normal; line-height: 1.4; }
  .lg-point b { display: block; color: #f0ece1; font-weight: 600; font-size: 12.2px; letter-spacing: .02em; }
  .lg-rule { height: 1px; background: rgba(255,255,255,.09); margin: 26px 0 14px; position: relative; z-index: 1; }
  .lg-foot-brand { font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: #61727d; position: relative; z-index: 1; }
  .lg-form-wrap { display: grid; place-items: center; padding: 40px 34px; }
  .lg-card { width: min(392px, 100%); }
  .lg-eyebrow { font-size: 10.5px; letter-spacing: .22em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
  .lg-card h1 { font-family: var(--serif); font-size: 27px; color: var(--ink); margin-top: 7px; letter-spacing: .01em; }
  .lg-hint { font-size: 12.5px; color: var(--muted); margin: 7px 0 22px; line-height: 1.7; }
  .lg-error { background: var(--danger-soft); color: var(--danger); border-left: 3px solid var(--danger); border-radius: 6px; padding: 8px 11px; font-size: 12px; margin-bottom: 12px; }
  .lg-brand-mobile { display: none; align-items: center; gap: 10px; margin-bottom: 24px; }
  .lg-demo { margin-top: 22px; border-top: 1px dashed var(--line); padding-top: 14px; }
  .lg-demo .da-title { font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
  .lg-demo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .demo-account { text-align: left; border: 1px solid var(--line); background: var(--card); border-radius: 7px; padding: 6px 9px; font-size: 11px; color: var(--ink-3); transition: all .12s; }
  .demo-account:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .demo-account strong { display: block; color: var(--ink); font-size: 11.5px; font-weight: 600; }
  .demo-account:hover strong { color: var(--accent); }
  .demo-account.muted-item { grid-column: 1 / -1; }
  .lg-note { font-size: 11.5px; color: var(--muted); margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); display: flex; gap: 7px; align-items: flex-start; }
  .lg-note i { color: var(--jade); font-style: normal; }
  @media (max-width: 1080px) {
    .lg-page { grid-template-columns: 1fr; }
    .lg-visual { display: none; }
    .lg-form-wrap { padding: 26px 18px; }
    .lg-brand-mobile { display: flex; }
  }
</style>`;

export default {
  title: '登录',
  render(root) {
    root.innerHTML = `${STYLE}
      <div class="lg-page">
        <aside class="lg-visual">
          <div class="lg-brand">
            <span class="brand-mark">B</span>
            <span><strong>BidCore</strong><em>标序 · 投标协作平台</em></span>
          </div>
          <h1 class="lg-headline">把招标文件，<br>变成<em>可审核</em>的投标文件。</h1>
          <p class="lg-sub">Supervisor 先出计划，专业 Agent 分头执行，质量门禁打分，人工在关键节点裁决。每一步都有证据、有版本、有返工路径。</p>
          <div class="lg-points">
            ${POINTS.map(([title, desc]) => `<div class="lg-point"><i>◆</i><span><b>${escapeHtml(title)}</b>${escapeHtml(desc)}</span></div>`).join('')}
          </div>
          <div class="lg-rule"></div>
          <div class="lg-foot-brand">Multi-Agent · Human-in-the-Loop · Self-Loop</div>
        </aside>

        <div class="lg-form-wrap">
          <div class="lg-card">
            <div class="lg-brand-mobile">
              <span class="brand-mark">B</span>
              <span><strong style="font-size:14px;color:var(--ink)">BidCore</strong><em style="font-style:normal;font-size:10.5px;color:var(--muted);letter-spacing:.1em;display:block">标序 · 投标协作平台</em></span>
            </div>
            <div class="lg-eyebrow">登录工作台</div>
            <h1>进入 BidCore</h1>
            <p class="lg-hint">使用企业账号登录；审核、决策与导出操作全部留痕，可在审核中心追溯。</p>

            <div class="lg-error" id="lg-error" hidden></div>
            <form id="lg-form" autocomplete="on" novalidate>
              <div class="field">
                <label for="lg-user">账号</label>
                <input class="input" id="lg-user" name="username" value="admin" autocomplete="username" spellcheck="false" />
              </div>
              <div class="field">
                <label for="lg-pass">密码</label>
                <input class="input" id="lg-pass" name="password" type="password" value="admin123" autocomplete="current-password" />
              </div>
              <button class="btn primary block" id="lg-submit" type="submit" style="height:38px">登录</button>
            </form>

            <div class="lg-demo">
              <div class="da-title">演示账号 · 点击填充</div>
              <div class="lg-demo-grid">
                ${DEMO_ACCOUNTS.map(([user, , role]) => `<button type="button" class="demo-account" data-user="${user}" data-pass="${user === 'admin' ? 'admin123' : `${user}123`}"><strong>${escapeHtml(user)}</strong>${escapeHtml(role)}</button>`).join('')}
              </div>
            </div>

            <div class="lg-note"><i>●</i><span>离线可用：未配置模型时走确定性 Mock，解析、目录、正文、检查与导出流程仍可完整跑通。</span></div>
          </div>
        </div>
      </div>`;

    const form = $('#lg-form', root);
    const errorBox = $('#lg-error', root);
    const button = $('#lg-submit', root);
    const userInput = $('#lg-user', root);
    const passInput = $('#lg-pass', root);

    const showError = (message) => {
      errorBox.textContent = message;
      errorBox.hidden = false;
    };

    let busy = false;
    const submit = async () => {
      if (busy) return;
      const username = userInput.value.trim();
      const password = passInput.value;
      errorBox.hidden = true;
      if (!username || !password) { showError('请填写账号与密码'); return; }
      busy = true;
      button.disabled = true;
      button.textContent = '登录中…';
      try {
        const res = await api.login(username, password);
        store.token = res.token;
        if (res.user?.id) store.user = res.user;
        location.reload();
      } catch (error) {
        busy = false;
        button.disabled = false;
        button.textContent = '登录';
        showError(error?.message || '账号或密码不正确');
        passInput.focus();
        passInput.select();
      }
    };

    form.onsubmit = (event) => { event.preventDefault(); submit(); };

    for (const node of root.querySelectorAll('.demo-account')) {
      node.onclick = () => {
        userInput.value = node.dataset.user;
        passInput.value = node.dataset.pass;
        errorBox.hidden = true;
        passInput.focus();
      };
    }
  },
};
