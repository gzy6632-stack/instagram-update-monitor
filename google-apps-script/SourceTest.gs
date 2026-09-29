// 一次性数据源测速/新鲜度测试。
// 不会发送邮件，不会修改监控状态，也不会创建触发器。
// 在 Apps Script 中新增一个 SourceTest.gs 文件并粘贴本文件，
// 然后手动运行 testAlternativeSources() 即可。

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

function testAlternativeSources() {
  console.log('===== Alternative Instagram source test started =====');

  ALT_TEST_SOURCES.forEach(source => {
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
          `[SOURCE TEST] ${source.name} | @${def.username} | ` +
          `latest=${latest.id} | published=${latest.published || 'unknown'} | ` +
          `age=${ageMinutes} min | items=${items.length} | ${latest.link}`
        );
      } catch (err) {
        console.warn(
          `[SOURCE TEST] ${source.name} | @${def.username} | FAILED: ` +
          `${err && err.message ? err.message : err}`
        );
      }
    });
  });

  console.log('\n===== Alternative Instagram source test completed =====');
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

  // Viewer bridges（如 Imgsed / Picuki）的 <link> 往往指向 viewer 自己，
  // 但正文里会包含真正的 instagram.com/p/... 链接，所以扫描整个条目 XML。
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

  // 先处理普通 URL。
  let match = String(raw).match(
    /https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([^\s<>'\"&?#/]+)\/?/i
  );

  // XML/HTML 中 URL 偶尔会被编码；做一次最小解码再试。
  if (!match) {
    const decoded = String(raw)
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    match = decoded.match(
      /https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([^\s<>'\"&?#/]+)\/?/i
    );
  }

  if (!match) return null;

  let kind = match[1].toLowerCase();
  if (kind === 'reels') kind = 'reel';
  const id = match[2];
  return {
    id,
    link: `https://www.instagram.com/${kind}/${id}/`,
  };
}
