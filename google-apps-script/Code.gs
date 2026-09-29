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

// 当前保留两个最有价值的 RSS-Bridge 源。
// 所有账号、所有源会一次性并行请求，避免某个 60 秒超时把 5 个账号逐个拖慢。
const RSS_SOURCES = [
  'https://rss-bridge.sans-nuage.fr/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom',
  'https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom',
];

const INITIAL_STATE = {
  accounts: {
    aerichandesu: {
      seen_ids: ['Ddu36i1E0Aw', 'Ddceq2wDtpg', 'DdU7CpfDnaB', 'DdSwPPPjieL', 'DdFXyUFDs2d', 'DcqlNn_k6SI'],
      last_source: 'https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u=aerichandesu&media_type=all&format=Atom',
    },
    aespa_official: {
      seen_ids: ['Dd3jKdBlDIX', 'Dd3fsxmlJYj', 'Dd3EWYPFCGB', 'DdyZic6sIfG', 'DdyWL05lAxS', 'Ddx11DdlJMB'],
      last_source: 'https://rss-bridge.sans-nuage.fr/?action=display&bridge=InstagramBridge&context=Username&u=aespa_official&media_type=all&format=Atom',
    },
    imnotningning: {
      seen_ids: ['Dd2s7dPkwNr', 'Dd0jdI8E7lZ', 'Dd0iwLSkyb3', 'Ddsjt2nk6MV', 'DdsGYCulxbd', 'DdjgF9XDn82'],
      last_source: 'https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u=imnotningning&media_type=all&format=Atom',
    },
    imwinter: {
      seen_ids: ['DdslA4HkzvL', 'DdVmGMpnFjl', 'DdUaEpoE7RS', 'DdUXV_DEzwD', 'DdQhBSGnMSY', 'DdQgKBxHJkM'],
      last_source: 'https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u=imwinter&media_type=all&format=Atom',
    },
    katarinabluu: {
      seen_ids: ['Dd2T6sCE41g', 'Dd2SBgKk-2F', 'Ddk9jXiAKtF', 'DdZXEclE3tn', 'DdUNte9E1lv', 'DdR3FykkxqP'],
      last_source: 'https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u=katarinabluu&media_type=all&format=Atom',
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
    const allResults = fetchAllFeedsParallel_();

    ACCOUNTS.forEach(username => {
      const accountStarted = Date.now();
      try {
        console.log(`Checking @${username} ...`);
        const result = allResults[username];
        if (!result || result.items.length === 0) {
          const detail = result && result.errors.length ? result.errors.join(' || ') : 'no usable responses';
          throw new Error(`all feed sources failed or returned no valid items | ${detail}`);
        }

        const previous = state.accounts[username] || { seen_ids: [], last_source: '' };
        const items = result.items;
        const latest = items[0];

        console.log(
          `Latest MERGED Instagram item for @${username}: ` +
          `id=${latest.id} | published=${latest.published} | link=${latest.link} | ` +
          `sources=${result.successfulUrls.length}`
        );

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
            console.log(`Initializing @${username}; no recent items to back-notify.`);
          }
        } else {
          const newItems = items.filter(item => !seenIds.has(item.id));
          newItems.slice().reverse().forEach(item => notifyNewPost_(username, item, ''));
          if (newItems.length === 0) {
            console.log(`No new posts for @${username}.`);
          }
        }

        const mergedSeen = currentIds.concat(
          Array.from(seenIds).filter(id => !currentIds.includes(id))
        );

        state.accounts[username] = {
          seen_ids: mergedSeen.slice(0, 100),
          last_source: result.successfulUrls[0] || previous.last_source || '',
        };
      } catch (err) {
        console.error(`Failed to check @${username}: ${err && err.message ? err.message : err}`);
      } finally {
        console.log(`Finished @${username} in ${((Date.now() - accountStarted) / 1000).toFixed(1)}s.`);
      }
    });

    saveState_(state);
  } finally {
    lock.releaseLock();
    console.log(`Monitor run finished in ${((Date.now() - runStarted) / 1000).toFixed(1)}s.`);
  }
}

function fetchAllFeedsParallel_() {
  const defs = [];
  const requests = [];

  ACCOUNTS.forEach(username => {
    RSS_SOURCES.forEach(template => {
      const url = template.replace('{username}', encodeURIComponent(username));
      defs.push({ username, url });
      requests.push({
        url,
        method: 'get',
        followRedirects: true,
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      });
    });
  });

  console.log(`Starting ${requests.length} feed requests in parallel ...`);
  const batchStarted = Date.now();
  let responses;

  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (err) {
    throw new Error(`parallel feed batch failed: ${err && err.message ? err.message : err}`);
  }

  console.log(`Parallel feed batch finished in ${((Date.now() - batchStarted) / 1000).toFixed(1)}s.`);

  const grouped = {};
  ACCOUNTS.forEach(username => {
    grouped[username] = {
      mergedById: new Map(),
      successfulUrls: [],
      errors: [],
      items: [],
    };
  });

  responses.forEach((response, index) => {
    const def = defs[index];
    const bucket = grouped[def.username];

    try {
      const code = response.getResponseCode();
      if (code !== 200) throw new Error(`HTTP ${code}`);

      const parsed = parseFeed_(response.getContentText()).slice(0, MAX_ITEMS);
      const validItems = parsed.filter(item => item && item.id && item.link);
      if (validItems.length === 0) {
        throw new Error('feed contained no valid Instagram post/reel links');
      }

      bucket.successfulUrls.push(def.url);
      console.log(`Feed source succeeded for @${def.username}: ${def.url}`);

      validItems.forEach(item => {
        const existing = bucket.mergedById.get(item.id);
        if (!existing) {
          bucket.mergedById.set(item.id, item);
          return;
        }

        const existingHasTime = Number.isFinite(existing.publishedMs);
        const itemHasTime = Number.isFinite(item.publishedMs);
        if ((!existingHasTime && itemHasTime) ||
            (existing.title === 'Instagram 更新' && item.title !== 'Instagram 更新')) {
          bucket.mergedById.set(item.id, item);
        }
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      bucket.errors.push(`${def.url}: ${message}`);
      console.warn(`Feed source failed for @${def.username}: ${def.url}: ${message}`);
    }
  });

  ACCOUNTS.forEach(username => {
    const bucket = grouped[username];
    const items = Array.from(bucket.mergedById.values());
    items.sort((a, b) => {
      const aTime = Number.isFinite(a.publishedMs) ? a.publishedMs : 0;
      const bTime = Number.isFinite(b.publishedMs) ? b.publishedMs : 0;
      return bTime - aTime;
    });
    bucket.items = items.slice(0, MAX_ITEMS);
    delete bucket.mergedById;
  });

  return grouped;
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
