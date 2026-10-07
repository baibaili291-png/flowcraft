/*
 * nodes.js —— 节点类型注册表（自研的"算子库"）。
 *
 * 每个节点类型描述：端口、默认配置、属性面板的字段，以及最核心的 run(config, inputs)。
 * run 接收上游输入（按输入端口名索引的对象），返回按输出端口名索引的结果。
 * 条件类节点额外返回 __branch，引擎只沿被激活的那条出边继续往下传。
 *
 * 设计取舍：
 *  - 节点逻辑用"纯函数 + 异步"表达，引擎完全不关心每个节点内部在干什么，
 *    想加新算子（比如"向量检索""SQL 查询"）只要在这里登记一个类型即可，零侵入。
 *  - LLM / HTTP 默认走"模拟模式"：不联网也能把整条链路跑通、把编排逻辑验证掉，
 *    和 InsightKB 的 mock-first 哲学一致；填了 Base URL 才真联网（受 CORS 限制，生产走后端代理）。
 *  - transform 节点允许用户输入一段 JS（input 进、return 出），用来演示"动态执行"，
 *    这是工作流编排里最灵活的一格；安全上等同于"允许用户写脚本"，简历里要讲清楚边界。
 */
(function (global) {
  'use strict';

  const NODE_TYPES = {
    start: {
      type: 'start',
      title: '开始 / 输入',
      color: '#2563eb',
      inputs: [],
      outputs: ['text'],
      fields: [{ key: 'text', label: '初始文本', type: 'textarea' }],
      defaultConfig: { text: '请介绍 Model X200 的额定功率' },
      async run(config) {
        return { text: config.text || '' };
      },
    },

    llm: {
      type: 'llm',
      title: 'LLM 调用',
      color: '#7c3aed',
      inputs: ['text'],
      outputs: ['text'],
      fields: [
        { key: 'baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
        { key: 'apiKey', label: 'API Key（留空走模拟）', type: 'text', placeholder: 'sk-...' },
        { key: 'model', label: '模型名', type: 'text' },
        { key: 'prompt', label: '提示词模板（用 {{text}} 引用上游）', type: 'textarea' },
        { key: 'mock', label: '模拟模式（不联网）', type: 'checkbox' },
      ],
      defaultConfig: { baseUrl: '', apiKey: '', model: 'deepseek-chat', prompt: '{{text}}', mock: true },
      async run(config, inputs) {
        const prompt = String(config.prompt || '{{text}}').split('{{text}}').join(inputs.text || '');
        if (config.mock || !config.baseUrl) {
          return { text: `【LLM 模拟输出】\n针对输入：“${prompt}”\n（接入真实 API 后，此处为模型生成内容）` };
        }
        try {
          const resp = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (config.apiKey || '') },
            body: JSON.stringify({
              model: config.model || 'deepseek-chat',
              messages: [{ role: 'user', content: prompt }],
              stream: false,
            }),
          });
          const data = await resp.json();
          const text =
            data && data.choices && data.choices[0] && data.choices[0].message
              ? data.choices[0].message.content
              : JSON.stringify(data);
          return { text: text || '' };
        } catch (e) {
          return { text: `【LLM 调用失败】${e.message}（可能受 CORS 限制，生产应走后端代理）` };
        }
      },
    },

    if: {
      type: 'if',
      title: '条件分支',
      color: '#d97706',
      inputs: ['text'],
      outputs: ['true', 'false'],
      fields: [
        { key: 'op', label: '判断方式', type: 'select', options: ['contains', 'equals', 'notEmpty', 'regex'] },
        { key: 'value', label: '比较值', type: 'text' },
      ],
      defaultConfig: { op: 'contains', value: '' },
      async run(config, inputs) {
        const v = inputs.text == null ? '' : String(inputs.text);
        let res = false;
        switch (config.op) {
          case 'contains':
            res = v.includes(config.value || '');
            break;
          case 'equals':
            res = v === (config.value || '');
            break;
          case 'notEmpty':
            res = v.trim().length > 0;
            break;
          case 'regex':
            try {
              res = new RegExp(config.value || '').test(v);
            } catch (_) {
              res = false;
            }
            break;
          default:
            res = false;
        }
        return { true: v, false: v, __branch: res ? 'true' : 'false' };
      },
    },

    transform: {
      type: 'transform',
      title: '代码 (JS)',
      color: '#0891b2',
      inputs: ['input'],
      outputs: ['output'],
      fields: [{ key: 'code', label: 'JS 代码（可写 return，输入变量为 input）', type: 'textarea' }],
      defaultConfig: { code: "// input 是上游传入的值\nreturn (input || '').toUpperCase();" },
      async run(config, inputs) {
        try {
          const fn = new Function('input', config.code || 'return input;');
          return { output: fn(inputs.input) };
        } catch (e) {
          throw new Error('代码执行错误：' + e.message);
        }
      },
    },

    http: {
      type: 'http',
      title: 'HTTP 请求',
      color: '#0d9488',
      inputs: ['body'],
      outputs: ['response'],
      fields: [
        { key: 'url', label: 'URL', type: 'text' },
        { key: 'method', label: '方法', type: 'select', options: ['GET', 'POST'] },
        { key: 'mock', label: '模拟模式', type: 'checkbox' },
      ],
      defaultConfig: { url: 'https://api.example.com/v1/x', method: 'GET', mock: true },
      async run(config, inputs) {
        if (config.mock || !config.url) {
          return { response: JSON.stringify({ mock: true, echo: inputs.body || null, ts: Date.now() }, null, 2) };
        }
        try {
          const resp = await fetch(config.url, { method: config.method || 'GET' });
          return { response: await resp.text() };
        } catch (e) {
          return { response: '【HTTP 调用失败】' + e.message };
        }
      },
    },

    end: {
      type: 'end',
      title: '结束 / 输出',
      color: '#475569',
      inputs: ['text'],
      outputs: [],
      terminal: true,
      fields: [],
      defaultConfig: {},
      async run() {
        return {};
      },
    },
  };

  global.FC = global.FC || {};
  global.FC.NODE_TYPES = NODE_TYPES;
  if (typeof module !== 'undefined' && module.exports) module.exports = { NODE_TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
