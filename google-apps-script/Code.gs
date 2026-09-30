const ACCOUNTS = [
  'aespa_official',
  'katarinabluu',
  'imwinter',
  'aerichandesu',
  'imnotningning',
];

// 第一次使用时，把这里改成你真正接收通知的邮箱地址。
const NOTIFY_EMAIL = 'CHANGE_ME@example.com';

const MAX_ITEMS = 20;
const INITIAL_NOTIFY_WINDOW_MS = 60 * 60 * 1000;
const STATE_KEY = 'INSTAGRAM_MONITOR_STATE_V1';
const CHINA_TIME_ZONE = 'Asia/Shanghai';

// 主源：本次实测对 Karina / Winter / Giselle / Ningning 可用，而且速度快。
// 每 5 分钟都检查一次。
const PRIMARY_SOURCE =
  'https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom';

// 备用源：有时能补到主源缺失的内容，但也会出现约 60 秒的 504。
// 为避免每天大量超时占满 Apps Script 运行额度，只每 30 分钟检查一次。
const FALLBACK_SOURCE =
  'https://rss-bridge.sans-nuage.fr/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom';
const FALLBACK_INTERVAL_MS = 30 * 60 * 1000;
const FALLBACK_LAST_RUN_KEY = 'INSTAGRAM_FALLBACK_LAST_RUN_V1';

const INITIAL_STATE = {
  accounts: {
    aerichandesu: {
      seen_ids: ['Ddu36i1E0Aw', 'Ddceq2wDtpg', 'DdU7CpfDnaB', 'DdSwPPPjieL', 'DdFXyUFDs2d', 'DcqlNn_k6SI'],
      last_source: PRIMARY_SOURCE.replace('{username}', 'aerichandesu'),
    },
    aespa_official: {
      seen_ids: ['Dd3jKdBlDIX', 'Dd3fsxmlJYj', 'Dd3EWYPFCGB', 'DdyZic6sIfG', 'DdyWL05lAxS', 'Ddx11DdlJMB'],
      last_source: FALLBACK_SOURCE.replace('{username}', 'aespa_official'),
    },
    imnotningning: {
      seen_ids: ['Dd2s7dPkwNr', 'Dd0jdI8E7lZ', 'Dd0iwLSkyb3', 'Ddsjt2nk6MV', 'DdsGYCulxbd', 'DdjgF9XDn82'],
      last_source: PRIMARY_SOURCE.replace('{username}', 'imnotningning'),
    },
    imwinter: {
      seen_ids: ['DdslA4HkzvL', 'DdVmGMpnFjl', 'DdUaEpoE7RS', 'DdUXV_DEzwD', 'DdQhBSGnMSY', 'DdQgKBxHJkM'],
      last_source: PRIMARY_SOURCE.replace('{username}', 'imwinter'),
    },
    katarinabluu: {
      seen_ids: ['Dd2T6sCE41g', 'Dd2SBgKk-2F', 'Ddk9jXiAKtF', 'DdZXEclE3tn', 'DdUNte9E1lv', 'DdR3FykkxqP'],
      last_source: PRIMARY_SOURCE.replace('{username}', 'katarinabluu'),
    },
  },
};

function setupOnce() {
  validateNotifyEmail_();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(STATE_KEY)) {
    props.setProperty(STATE_KEY, JSON.stringify(INITIAL_STATE));
    console.log('Imported existing GitHub state.');
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'monitorInstagram')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('monitorInstagram')
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log('Created a 5-minute monitor trigger.');
  monitorInstagram();
}

function sendTestEmail() {
  validateNotifyEmail_();
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: '✅ Instagram 监控迁移测试',
    body: 'Google Apps Script 邮件发送正常。\n\n之后 Instagram 更新会由 Google 云端监控。',
    name: 'Instagram Update Monitor',
  });
}

function monitorInstagram() {
  validateNotifyEmail_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Another monitor run is already active; skipping this run.');
    return;
  }

  const runStarted = Date.now();

  try {
    const state = loadState_();
    const now = new Date();

    // 第一阶段：每 5 分钟执行的快速主源检查。
    console.log('===== FAST PRIMARY PASS =====');
    const primaryResults = fetchSourceBatch_(PRIMARY_SOURCE, true);
    processSourceResults_(primaryResults, state, now, 'PRIMARY');
    // 主源发现的新帖立即写入状态，不等备用源。
    saveState_(state);

    // 第二阶段：慢备用源只定期执行，避免 504 每 5 分钟消耗大量运行时间。
    if (shouldRunFallback_()) {
      console.log('===== FALLBACK PASS (30-minute cadence) =====');
      const fallbackResults = fetchSourceBatch_(FALLBACK_SOURCE, false);
      processSourceResults_(fallbackResults, state, now, 'FALLBACK');
      saveState_(state);
      PropertiesService.getScriptProperties()
        .setProperty(FALLBACK_LAST_RUN_KEY, String(Date.now()));
    } else {
      console.log('Fallback source skipped this run; it is checked every 30 minutes.');
    }
  } finally {
    lock.releaseLock();
    console.log(`Monitor run finished in ${((Date.now() - runStarted) / 1000).toFixed(1)}s.`);
  }
}

function shouldRunFallback_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(FALLBACK_LAST_RUN_KEY);
  if (!raw) return true;
  const last = Number(raw);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= FALLBACK_INTERVAL_MS;
}

// 一次请求同一数据源的 5 个账号。
// 主源如果 fetchAll 出现 Address unavailable，会逐个快速补救；
// 备用源若整批连接失败则直接跳过，避免 5 个 60 秒超时串行累积。
function fetchSourceBatch_(template, salvageIndividually) {
  const sourceName = template.split('/')[2] || template;
  const defs = ACCOUNTS.map(username => ({
    username,
    url: template.replace('{username}', encodeURIComponent(username)),
  }));

  const results = {};
  ACCOUNTS.forEach(username => {
    results[username] = { items: [], sourceUrl: '', error: '' };
  });

  const requests = defs.map(def => buildRequest_(def.url));
  const started = Date.now();
  console.log(`Starting ${ACCOUNTS.length} parallel requests for ${sourceName} ...`);

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
    console.log(
      `Source batch ${sourceName} finished in ${((Date.now() - started) / 1000).toFixed(1)}s.`
    );
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(`Source batch ${sourceName} transport failure: ${message}`);

    if (!salvageIndividually) {
      ACCOUNTS.forEach(username => {
        results[username].error = message;
      });
      return results;
    }

    console.log(`Salvaging ${sourceName} one account at a time ...`);
    defs.forEach(def => {
      try {
        const response = UrlFetchApp.fetch(def.url, buildRequestOptions_());
        results[def.username] = parseSourceResponse_(response, def.url);
      } catch (singleErr) {
        const singleMessage = singleErr && singleErr.message ? singleErr.message : String(singleErr);
        results[def.username].error = singleMessage;
        console.warn(`Source failed for @${def.username}: ${sourceName}: ${singleMessage}`);
      }
    });
    return results;
  }

  responses.forEach((response, index) => {
    const def = defs[index];
    try {
      results[def.username] = parseSourceResponse_(response, def.url);
      console.log(`Source succeeded for @${def.username}: ${sourceName}`);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      results[def.username].error = message;
      console.warn(`Source failed for @${def.username}: ${sourceName}: ${message}`);
    }
  });

  return results;
}

function buildRequest_(url) {
  const opts = buildRequestOptions_();
  opts.url = url;
  return opts;
}

function buildRequestOptions_() {
  return {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
  };
}

function parseSourceResponse_(response, sourceUrl) {
  const code = response.getResponseCode();
  if (code !== 200) throw new Error(`HTTP ${code}`);

  const parsed = parseFeed_(response.getContentText()).slice(0, MAX_ITEMS);
  const validItems = parsed.filter(item => item && item.id && item.link);
  if (validItems.length === 0) {
    throw new Error('feed contained no valid Instagram post/reel links');
  }

  validItems.sort((a, b) => {
    const aTime = Number.isFinite(a.publishedMs) ? a.publishedMs : 0;
    const bTime = Number.isFinite(b.publishedMs) ? b.publishedMs : 0;
    return bTime - aTime;
  });

  return {
    items: validItems,
    sourceUrl,
    error: '',
  };
}

function processSourceResults_(results, state, now, label) {
  ACCOUNTS.forEach(username => {
    const result = results[username];
    if (!result || result.items.length === 0) {
      console.warn(
        `[${label}] @${username}: no usable feed data` +
        (result && result.error ? ` | ${result.error}` : '')
      );
      return;
    }

    const items = result.items;
    const latest = items[0];
    console.log(
      `[${label}] Latest for @${username}: ` +
      `id=${latest.id} | published=${latest.published} | link=${latest.link}`
    );

    const previous = state.accounts[username] || { seen_ids: [], last_source: '' };
    const seenIds = new Set(previous.seen_ids || []);
    const currentIds = items.map(item => item.id);

    if (seenIds.size === 0) {
      const recentItems = items.filter(item => isRecent_(item, now));
      recentItems.slice().reverse().forEach(item => {
        notifyNewPost_(
          username,
          item,
          '首次初始化保护：该内容发布时间在最近 1 小时内，因此仍发送提醒。'
        );
      });
      if (recentItems.length === 0) {
        console.log(`[${label}] Initializing @${username}; no recent items to back-notify.`);
      }
    } else {
      const newItems = items.filter(item => !seenIds.has(item.id));
      newItems.slice().reverse().forEach(item => notifyNewPost_(username, item, ''));
      if (newItems.length === 0) {
        console.log(`[${label}] No new posts for @${username}.`);
      }
    }

    const mergedSeen = currentIds.concat(
      Array.from(seenIds).filter(id => !currentIds.includes(id))
    );

    state.accounts[username] = {
      seen_ids: mergedSeen.slice(0, 100),
      last_source: result.sourceUrl || previous.last_source || '',
    };
  });
}

function parseFeed_(xmlText) {
  const doc = XmlService.parse(xmlText);
  const root = doc.getRootElement();
  const rootName = root.getName().toLowerCase();
  const items = [];

  if (rootName === 'feed') {
    const ns = root.getNamespace();
    root.getChildren('entry', ns).forEach(entry => {
      const title = getChildText_(entry, 'title', ns) || 'Instagram 更新';
      if (looksLikeBridgeError_(title)) return;

      let link = '';
      const linkElements = entry.getChildren('link', ns);
      for (let i = 0; i < linkElements.length; i++) {
        const href = linkElements[i].getAttribute('href');
        if (href && instagramPermalink_(href.getValue())) {
          link = href.getValue();
          break;
        }
      }
      if (!link) link = getChildText_(entry, 'id', ns) || '';

      const normalized = instagramPermalink_(link);
      if (!normalized) return;

      const published =
        getChildText_(entry, 'published', ns) ||
        getChildText_(entry, 'updated', ns) ||
        '';

      items.push({
        id: normalized.id,
        title,
        link: normalized.link,
        published,
        publishedMs: parseDateMs_(published),
      });
    });
  } else if (rootName === 'rss') {
    const channel = root.getChild('channel');
    if (!channel) return items;

    channel.getChildren('item').forEach(item => {
      const title = getChildText_(item, 'title', null) || 'Instagram 更新';
      if (looksLikeBridgeError_(title)) return;

      const link = getChildText_(item, 'link', null) || getChildText_(item, 'guid', null) || '';
      const normalized = instagramPermalink_(link);
      if (!normalized) return;

      const published = getChildText_(item, 'pubDate', null) || '';
      items.push({
        id: normalized.id,
        title,
        link: normalized.link,
        published,
        publishedMs: parseDateMs_(published),
      });
    });
  }

  return items;
}

function instagramPermalink_(value) {
  if (!value) return null;
  const match = String(value).match(/https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([^/?#]+)\/?/i);
  if (!match) return null;
  let kind = match[1].toLowerCase();
  if (kind === 'reels') kind = 'reel';
  const id = match[2];
  return {
    id,
    link: `https://www.instagram.com/${kind}/${id}/`,
  };
}

function notifyNewPost_(username, item, note) {
  const chinaTime = formatChinaTime_(item.publishedMs);
  const noteBlock = note ? `\n${note}\n` : '';
  const body =
    `@${username} 发现新的 Instagram 内容。\n` +
    `${noteBlock}\n` +
    `标题：${item.title}\n` +
    `发布时间：${chinaTime}\n` +
    `链接：${item.link}\n\n` +
    '此邮件由 Google Apps Script 自动发送。';

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: `🔔 Instagram 更新：@${username}`,
    body,
    name: 'Instagram Update Monitor',
  });

  console.log(`Notification sent for @${username}: ${item.link}`);
}

function formatChinaTime_(publishedMs) {
  if (!publishedMs || Number.isNaN(publishedMs)) return '未知';
  return Utilities.formatDate(new Date(publishedMs), CHINA_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss') + '（北京时间，UTC+8）';
}

function parseDateMs_(value) {
  if (!value) return NaN;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? NaN : ms;
}

function isRecent_(item, now) {
  if (!item.publishedMs || Number.isNaN(item.publishedMs)) return false;
  const delta = now.getTime() - item.publishedMs;
  return delta >= -5 * 60 * 1000 && delta <= INITIAL_NOTIFY_WINDOW_MS;
}

function looksLikeBridgeError_(title) {
  const lower = String(title || '').toLowerCase();
  return lower.includes('bridge returned error') || lower.startsWith('error');
}

function getChildText_(parent, name, ns) {
  const child = ns ? parent.getChild(name, ns) : parent.getChild(name);
  return child ? child.getText().trim() : '';
}

function loadState_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(STATE_KEY);
  if (!raw) return JSON.parse(JSON.stringify(INITIAL_STATE));
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.accounts) parsed.accounts = {};
    return parsed;
  } catch (err) {
    console.warn('State was invalid; restoring migrated GitHub state.');
    return JSON.parse(JSON.stringify(INITIAL_STATE));
  }
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

function validateNotifyEmail_() {
  if (!NOTIFY_EMAIL || NOTIFY_EMAIL === 'CHANGE_ME@example.com' || !NOTIFY_EMAIL.includes('@')) {
    throw new Error('请先把 Code.gs 顶部的 NOTIFY_EMAIL 改成你的接收邮箱地址。');
  }
}
