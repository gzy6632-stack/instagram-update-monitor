// 一次性数据源测速/新鲜度测试。
// 不会发送邮件，不会修改监控状态，也不会创建触发器。
// 本文件依赖 Code.gs 中已经存在的 ACCOUNTS、instagramPermalink_、
// getChildText_、looksLikeBridgeError_、parseDateMs_ 等函数。

const ALT_TEST_SOURCES = [
  {
    name: 'sans-nuage / InstagramBridge（当前主源）',
    template: 'https://rss-bridge.sans-nuage.fr/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom',
  },
  {
    name: 'sans-nuage / ImgsedBridge（独立 Instagram Viewer）',
    template: 'https://rss-bridge.sans-nuage.fr/?action=display&bridge=ImgsedBridge&context=Username&u={username}&post=on&format=Atom',
  },
  {
    name: 'sans-nuage / PicukiBridge（独立 Instagram Viewer）',
    template: 'https://rss-bridge.sans-nuage.fr/?action=display&bridge=PicukiBridge&context=Username&u={username}&count=12&format=Atom',
  },
];

// 第二阶段：测试多个“独立 RSS-Bridge 实例”的同一个 InstagramBridge。
// 目的：找出哪个实例最早同步到 Instagram 新帖子。
const INSTANCE_TEST_SOURCES = [
  {
    name: 'sans-nuage',
    template: 'https://rss-bridge.sans-nuage.fr/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom',
  },
  {
    name: 'rss-bridge.org',
    template: 'https://rss-bridge.org/bridge01/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom',
  },
  {
    name: 'flossboxin',
    template: 'https://rssbridge.flossboxin.org.in/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom',
  },
  {
    name: 'cheredeprince',
    template: 'https://rss-bridge.cheredeprince.net/?action=display&bridge=InstagramBridge&context=Username&u={username}&media_type=all&format=Atom',
  },
];

function testAlternativeSources() {
  console.log('===== Alternative Instagram source test started =====');
  runSourceSet_(ALT_TEST_SOURCES, 'SOURCE TEST');
  console.log('\n===== Alternative Instagram source test completed =====');
}

function testIndependentInstances() {
  console.log('===== Independent RSS-Bridge instance test started =====');
  console.log('目标：比较同一 InstagramBridge 在不同公共实例上的更新速度。');
  runSourceSet_(INSTANCE_TEST_SOURCES, 'INSTANCE TEST');
  console.log('\n===== Independent RSS-Bridge instance test completed =====');
}

function runSourceSet_(sources, label) {
  sources.forEach(source => {
    const defs = ACCOUNTS.map(username => ({
      username,
      url: source.template.replace('{username}', encodeURIComponent(username)),
    }));

    const requests = defs.map(def => ({
      url: def.url,
      method: 'get',
      followRedirects: true,
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    }));

    console.log(`\n===== Testing: ${source.name} =====`);
    const started = Date.now();

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
      console.log(`Batch finished in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    } catch (err) {
      console.warn(`ENTIRE SOURCE FAILED: ${source.name}: ${err && err.message ? err.message : err}`);
      return;
    }

    responses.forEach((response, index) => {
      const def = defs[index];
      try {
        const code = response.getResponseCode();
        if (code !== 200) {
          throw new Error(`HTTP ${code}`);
        }

        const items = parseAlternativeFeed_(response.getContentText());
        if (items.length === 0) {
          throw new Error('no recognizable Instagram post links');
        }

        items.sort((a, b) => {
          const at = Number.isFinite(a.publishedMs) ? a.publishedMs : 0;
          const bt = Number.isFinite(b.publishedMs) ? b.publishedMs : 0;
          return bt - at;
        });

        const latest = items[0];
        const ageMinutes = Number.isFinite(latest.publishedMs)
          ? ((Date.now() - latest.publishedMs) / 60000).toFixed(1)
          : 'unknown';

        console.log(
          `[${label}] ${source.name} | @${def.username} | ` +
          `latest=${latest.id} | published=${latest.published || 'unknown'} | ` +
          `age=${ageMinutes} min | items=${items.length} | ${latest.link}`
        );
      } catch (err) {
        console.warn(
          `[${label}] ${source.name} | @${def.username} | FAILED: ` +
          `${err && err.message ? err.message : err}`
        );
      }
    });
  });
}

function parseAlternativeFeed_(xmlText) {
  const doc = XmlService.parse(xmlText);
  const root = doc.getRootElement();
  const rootName = root.getName().toLowerCase();
  const items = [];

  if (rootName === 'feed') {
    const ns = root.getNamespace();
    root.getChildren('entry', ns).forEach(entry => {
      const item = parseAlternativeElement_(entry, ns, true);
      if (item) items.push(item);
    });
  } else if (rootName === 'rss') {
    const channel = root.getChild('channel');
    if (!channel) return items;
    channel.getChildren('item').forEach(entry => {
      const item = parseAlternativeElement_(entry, null, false);
      if (item) items.push(item);
    });
  }

  const byId = new Map();
  items.forEach(item => {
    if (!byId.has(item.id)) byId.set(item.id, item);
  });
  return Array.from(byId.values());
}

function parseAlternativeElement_(element, ns, isAtom) {
  const title = getChildText_(element, 'title', ns) || 'Instagram 更新';
  if (looksLikeBridgeError_(title)) return null;

  let normalized = null;

  if (isAtom) {
    const links = element.getChildren('link', ns);
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute('href');
      if (!href) continue;
      normalized = instagramPermalink_(href.getValue());
      if (normalized) break;
    }

    if (!normalized) {
      normalized = instagramPermalink_(getChildText_(element, 'id', ns));
    }
  } else {
    normalized = instagramPermalink_(
      getChildText_(element, 'link', null) || getChildText_(element, 'guid', null) || ''
    );
  }

  // Viewer bridges 的 link 往往不是 Instagram；扫描整个条目，尝试提取正文里的真实 Instagram 链接。
  if (!normalized) {
    const raw = XmlService.getRawFormat().formatElement(element);
    normalized = extractInstagramPermalinkFromRaw_(raw);
  }

  if (!normalized) return null;

  let published = '';
  if (isAtom) {
    published =
      getChildText_(element, 'published', ns) ||
      getChildText_(element, 'updated', ns) ||
      '';
  } else {
    published = getChildText_(element, 'pubDate', null) || '';
  }

  return {
    id: normalized.id,
    link: normalized.link,
    title,
    published,
    publishedMs: parseDateMs_(published),
  };
}

function extractInstagramPermalinkFromRaw_(raw) {
  if (!raw) return null;

  let decoded = String(raw)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\\//g, '/');

  try {
    decoded = decodeURIComponent(decoded);
  } catch (e) {
    // 某些 feed 里有不完整的百分号编码；忽略即可。
  }

  let match = decoded.match(
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([^\s<>'\"&?#/]+)\/?/i
  );

  if (!match) return null;

  let kind = match[1].toLowerCase();
  if (kind === 'reels') kind = 'reel';
  const id = match[2];
  return {
    id,
    link: `https://www.instagram.com/${kind}/${id}/`,
  };
}
