'use strict';

function parseRuns(input) {
  const source = String(input || '').replace(/`([^`]*)`/g, '$1').replace(/`/g, '');
  const parts = source.split('**');
  const unclosed = (parts.length - 1) % 2 === 1;
  const runs = [];
  parts.forEach((part, index) => {
    if (!part) return;
    const strong = index % 2 === 1 && !(unclosed && index === parts.length - 1);
    const prev = runs[runs.length - 1];
    if (prev && prev.strong === strong) prev.text += part;
    else runs.push({ text: part, strong });
  });
  return runs;
}

function prefixRuns(prefix, body) {
  const runs = parseRuns(body);
  if (!runs.length) return [{ text: prefix, strong: false }];
  if (!runs[0].strong) {
    runs[0] = { text: prefix + runs[0].text, strong: false };
    return runs;
  }
  return [{ text: prefix, strong: false }].concat(runs);
}

function scrubAskText(text) {
  let out = String(text || '');
  out = out.replace(/[（(][^）)\n]{0,160}(?:工具返回|空数组|products)[^）)\n]{0,160}[）)]/gi, '');
  out = out.replace(/工具返回的?\s*[`']?products[`']?\s*为空数组/gi, '');
  out = out.replace(/[，,]?\s*也?没有返回任何关联的其他视频[。.]?/g, '');
  out = out.replace(/^当前视频信息如下[：:]?\s*$/gm, '');
  out = out.replace(/^[-*•]\s*(?:\*\*)?(?:标题|简介|品牌)(?:\*\*)?\s*[：:].*$/gm, '');
  out = out.replace(/^[-*•]\s*(?:\*\*)?讲解内容(?:\*\*)?\s*[：:]\s*/gm, '');
  out = out.replace(/[（(]\s*[）)]/g, '');
  out = out.replace(/[，,]\s*([。．])/g, '$1');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function formatAskRuns(text) {
  const lines = scrubAskText(text).replace(/\r\n/g, '\n').split('\n');
  const runs = [];
  let started = false;
  let gap = false;
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!line) {
      if (started) gap = true;
      continue;
    }
    const ordered = /^(\d+)[.、]\s+(.+)$/.exec(line);
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    let next;
    if (ordered) next = prefixRuns(ordered[1] + '. ', ordered[2]);
    else if (unordered) next = prefixRuns('• ', unordered[1]);
    else if (heading) next = parseRuns(heading[1]).map((run) => ({ text: run.text, strong: true }));
    else next = parseRuns(line);
    if (!next.length) continue;
    if (started) runs.push({ text: gap ? '\n\n' : '\n', strong: false });
    next.forEach((run) => runs.push(run));
    started = true;
    gap = false;
  }
  return runs.length ? runs : [{ text: '', strong: false }];
}

module.exports = { formatAskRuns };
