export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    let code = url.searchParams.get('code');

    // Support POST JSON juga
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      code = body.code || code;
    }

    if (!code) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Code required. Usage: ?code=7QeJkP' 
      }), { status: 400, headers: CORS_HEADERS });
    }

    // Clean code
    code = code.replace(/[^a-zA-Z0-9]/g, '');
    
    console.log(`[RESOLVE] Code: ${code}`);

    // Step 1: Fetch short URL
    const shortUrl = `https://permatamalam.online/${code}`;
    
    let res = await fetch(shortUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.google.com/',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      redirect: 'manual'
    });

    // Step 2: Follow redirect
    let finalUrl = shortUrl;
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      const location = res.headers.get('location');
      console.log(`[REDIRECT] ${location}`);
      finalUrl = location;
      
      res = await fetch(location, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': 'https://www.google.com/'
        }
      });
    }

    const html = await res.text();

    // Step 3: Extract data
    const data = extractVideoData(html, finalUrl);

    // Step 4: Resolve video domain ke IP (optional bypass)
    if (data.videoUrl && !data.resolvedIp) {
      try {
        const videoHost = new URL(data.videoUrl).hostname;
        const dohRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${videoHost}&type=A`, {
          headers: { 'Accept': 'application/dns-json' }
        });
        const dohData = await dohRes.json();
        data.resolvedIp = dohData.Answer?.[0]?.data || null;
        
        if (data.resolvedIp) {
          data.directUrl = data.videoUrl.replace(videoHost, data.resolvedIp);
        }
      } catch (e) {
        console.log('[DOH ERROR]', e.message);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      code: code,
      ...data,
      scrapedAt: new Date().toISOString()
    }), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    console.error('[ERROR]', err);
    return new Response(JSON.stringify({ 
      success: false, 
      error: err.message,
      stack: err.stack 
    }), { status: 500, headers: CORS_HEADERS });
  }
}

function extractVideoData(html, pageUrl) {
  const data = {
    title: null,
    videoUrl: null,
    iframeUrl: null,
    thumbnail: null,
    banners: [],
    metadata: {}
  };

  // Extract title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  data.title = titleMatch ? titleMatch[1].trim() : 'Unknown';

  // Extract iframe src
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch) {
    data.iframeUrl = iframeMatch[1];
    
    // Kalo langsung .mp4, itu video URL
    if (iframeMatch[1].match(/\.(mp4|m3u8|webm)($|\?)/i)) {
      data.videoUrl = iframeMatch[1];
    }
  }

  // Extract direct video URL dari berbagai pattern
  const videoPatterns = [
    /(https?:\/\/[^"']+\.(?:mp4|m3u8|webm)[^"']*)/i,
    /src=["'](https?:\/\/[^"']+\/uploads\/[^"']+)["']/i,
    /url\(["']?(https?:\/\/[^"']+\.mp4)["']?\)/i,
    /data-video=["'](https?:\/\/[^"']+)["']/i
  ];

  for (const pattern of videoPatterns) {
    const match = html.match(pattern);
    if (match && !data.videoUrl) {
      data.videoUrl = match[1];
      break;
    }
  }

  // Extract thumbnail/poster
  const posterMatch = html.match(/poster=["']([^"']+)["']/i) || 
                      html.match(/<meta[^>]+og:image[^>]+content=["']([^"']+)["']/i);
  if (posterMatch) data.thumbnail = posterMatch[1];

  // Extract banners (ads)
  const bannerRegex = /onclick=["']window\.location\.href=['"]([^'"]+)['"];?["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = bannerRegex.exec(html)) !== null) {
    data.banners.push({
      link: match[1],
      image: match[2].startsWith('http') ? match[2] : new URL(match[2], pageUrl).href
    });
  }

  // Extract metadata
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (descMatch) data.metadata.description = descMatch[1];

  return data;
}
