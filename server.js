const express = require('express');
const path = require('path');
const axios = require('axios');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
];

const COOKIE = 'ttwid=1%7C' + Date.now() + '%7C' + Math.random().toString(36).slice(2) + '%7C' + Math.random().toString(36).slice(2);

function sanitizeName(name) {
  return (name || 'tiktok_video')
    .replace(/[^\w\s\-_äöüßÄÖÜéèêëàâùûçÇ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 60) || 'tiktok_video';
}

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

app.post('/api/info', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.includes('tiktok.com')) {
    return res.status(400).json({ error: 'Ungültige TikTok-URL' });
  }

  try {
    // Try tikwm.com API first
    const result = await fetchFromTikwm(url);
    if (result) return res.json(result);

    // Fallback: direct extraction from TikTok page
    const fallback = await fetchFromTikTok(url);
    if (fallback) return res.json(fallback);

    return res.status(404).json({ error: 'Konnte Video nicht abrufen. Prüfe die URL und versuche es erneut.' });
  } catch (error) {
    console.error('Info error:', error.message);
    res.status(500).json({ error: 'Fehler beim Abrufen des Videos: ' + error.message });
  }
});

async function fetchFromTikwm(url) {
  try {
    const tikwmRes = await axios.post('https://www.tikwm.com/api/',
      `url=${encodeURIComponent(url)}`,
      {
        headers: {
          'User-Agent': randomUA(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Origin': 'https://www.tikwm.com',
          'Referer': 'https://www.tikwm.com/'
        },
        timeout: 15000
      }
    );

    const body = tikwmRes.data;
    if (body.code !== 0 || !body.data) return null;

    const d = body.data;
    const images = d.images?.filter?.(Boolean) || [];

    // Photo post
    if (images.length > 0) {
      return {
        success: true,
        isPhoto: true,
        images,
        info: {
          title: d.title || 'TikTok Bilder',
          author: d.author?.unique_id || d.author?.nickname || d.author?.name || 'Unbekannt',
          avatar: d.author?.avatar || '',
          duration: 0,
          plays: d.play_count || d.views || 0,
          likes: d.digg_count || d.likes || 0,
          comments: d.comment_count || 0,
          shares: d.share_count || 0,
          music: d.music_info?.title || '',
          cover: d.cover || d.origin_cover || ''
        }
      };
    }

    const videoUrl = d.play || d.wmplay || '';
    if (!videoUrl) return null;

    return {
      success: true,
      videoUrl,
      info: {
        title: d.title || 'TikTok Video',
        author: d.author?.unique_id || d.author?.nickname || d.author?.name || 'Unbekannt',
        avatar: d.author?.avatar || '',
        duration: d.duration || 0,
        plays: d.play_count || d.views || 0,
        likes: d.digg_count || d.likes || 0,
        comments: d.comment_count || 0,
        shares: d.share_count || 0,
        music: d.music_info?.title || '',
        cover: d.cover || d.origin_cover || ''
      }
    };
  } catch (e) {
    console.error('Tikwm error:', e.message);
    return null;
  }
}

async function fetchFromTikTok(url) {
  try {
    const ua = randomUA();
    const pageRes = await axios.get(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de,en-US;q=0.9,en;q=0.8',
        'Cookie': COOKIE
      },
      timeout: 15000,
      maxRedirects: 5
    });

    const html = pageRes.data;

    // Strategy 1: __UNIVERSAL_DATA_FOR_REHYDRATION__
    const rehydrateMatch = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (rehydrateMatch) {
      try {
        const data = JSON.parse(rehydrateMatch[1]);
        const seo = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct || {};
        const videoUrl = seo?.video?.playAddr?.[0] || seo?.video?.downloadAddr || null;
        if (videoUrl) {
          const author = seo?.author || {};
          const stats = seo?.stats || {};
          return {
            success: true,
            videoUrl: videoUrl.replace(/\\u002F/g, '/').replace(/\\/g, ''),
            info: {
              title: seo?.desc || 'TikTok Video',
              author: author?.uniqueId || author?.nickname || 'Unbekannt',
              avatar: author?.avatarLarger || author?.avatarThumb || '',
              duration: seo?.video?.duration || 0,
              plays: stats?.playCount || 0,
              likes: stats?.diggCount || 0,
              comments: stats?.commentCount || 0,
              shares: stats?.shareCount || 0,
              cover: seo?.video?.cover?.[0] || seo?.video?.dynamicCover?.[0] || ''
            }
          };
        }
      } catch (e) {}
    }

    // Strategy 2: __INITIAL_STATE__
    const initMatch = html.match(/<script[^>]*>window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/);
    if (initMatch) {
      try {
        const data = JSON.parse(initMatch[1]);
        const videoModule = data?.VideoModule?.video ||
                            data?.videoInfoRes?.itemInfo?.itemStruct ||
                            data?.videoInfo?.itemInfo?.itemStruct ||
                            {};
        const videoUrl = videoModule?.video?.playAddr?.[0] || videoModule?.video?.downloadAddr || null;
        if (videoUrl) {
          const author = videoModule?.author || {};
          const stats = videoModule?.stats || {};
          return {
            success: true,
            videoUrl: videoUrl.replace(/\\u002F/g, '/').replace(/\\/g, ''),
            info: {
              title: videoModule?.desc || 'TikTok Video',
              author: author?.uniqueId || author?.nickname || 'Unbekannt',
              avatar: author?.avatarLarger || author?.avatarThumb || '',
              duration: videoModule?.video?.duration || 0,
              plays: stats?.playCount || 0,
              likes: stats?.diggCount || 0,
              comments: stats?.commentCount || 0,
              shares: stats?.shareCount || 0,
              cover: videoModule?.video?.cover?.[0] || ''
            }
          };
        }
      } catch (e) {}
    }

    return null;
  } catch (e) {
    console.error('Direct fetch error:', e.message);
    return null;
  }
}

app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Keine Video-URL angegeben' });
  }

  try {
    const decodedUrl = decodeURIComponent(url);
    const ua = randomUA();

    const videoRes = await axios({
      method: 'get',
      url: decodedUrl,
      responseType: 'stream',
      maxRedirects: 5,
      headers: {
        'User-Agent': ua,
        'Referer': 'https://www.tiktok.com/',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      },
      timeout: 120000
    });

    const contentType = videoRes.headers['content-type'] || 'video/mp4';
    const contentLength = videoRes.headers['content-length'];
    const safeName = sanitizeName(filename || 'tiktok_video');

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp4"`);
    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    videoRes.data.pipe(res);

    videoRes.data.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download fehlgeschlagen' });
      }
    });

    req.on('close', () => {
      videoRes.data.destroy();
    });
  } catch (error) {
    console.error('Download error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download fehlgeschlagen: ' + error.message });
    }
  }
});

app.post('/api/download-zip', async (req, res) => {
  const { images, filename } = req.body;

  if (!images?.length) {
    return res.status(400).json({ error: 'Keine Bilder angegeben' });
  }

  try {
    const safeName = sanitizeName(filename || 'tiktok_images');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.pipe(res);

    const ua = randomUA();

    for (let i = 0; i < images.length; i++) {
      try {
        const imgRes = await axios({
          method: 'get',
          url: images[i],
          responseType: 'stream',
          headers: {
            'User-Agent': ua,
            'Referer': 'https://www.tiktok.com/'
          },
          timeout: 30000
        });
        archive.append(imgRes.data, { name: `bild_${String(i + 1).padStart(2, '0')}.jpg` });
      } catch (e) {
        console.error(`Image ${i} download error:`, e.message);
      }
    }

    archive.finalize();

    archive.on('error', (err) => {
      throw err;
    });
  } catch (error) {
    console.error('Zip error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Zip-Erstellung fehlgeschlagen: ' + error.message });
    }
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`TikTok Downloader läuft auf http://localhost:${PORT}`);
});
