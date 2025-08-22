$(function () {
  console.log("[FacebookEmbed] Scanning posts for facebook.com/fb.me links...");

  const PROXY = 'https://www.dimgord.cc';
  const RESOLVE_API = PROXY + '/resolve?url=';
  const OG_API = PROXY + '/og-proxy?url=';

  // --- helpers ---
  const isFbShort = (u) => /^https?:\/\/fb\.me\/.+/i.test(u);
  const normFb = (u) => u.replace(/^https?:\/\/m\.facebook\.com/i, 'https://www.facebook.com');

  const isPost = (u) => /https?:\/\/www\.facebook\.com\/([^\/?]+)\/posts\/(\d+)/i.exec(u);
  const isVideo = (u) => {
    // /<page>/videos/<id>  OR  /watch/?v=<id>
    const a = /https?:\/\/www\.facebook\.com\/(?:[^\/?]+\/)?videos\/(\d+)/i.exec(u);
    if (a) return { id: a[1], type: 'videos' };
    const b = /https?:\/\/www\.facebook\.com\/watch\/?\?v=(\d+)/i.exec(u);
    if (b) return { id: b[1], type: 'watch' };
    return null;
  };
  const isReel = (u) => /https?:\/\/www\.facebook\.com\/reel\/(\d+)/i.exec(u);
  const isPhotoNew = (u) => /https?:\/\/www\.facebook\.com\/photo\/\?fbid=(\d+)/i.exec(u);
  const isAlbumPhoto = (u) => /https?:\/\/www\.facebook\.com\/[^\/]+\/photos\/a\.[^\/]+\/(\d+)/i.exec(u);
  const isStory = (u) => /https?:\/\/www\.facebook\.com\/story\.php\?([^#]+)/i.exec(u);
  const isPermalink = (u) => /https?:\/\/www\.facebook\.com\/permalink\.php\?([^#]+)/i.exec(u);
  const isEvent = (u) => /https?:\/\/www\.facebook\.com\/events\/(\d+)/i.exec(u);
  const isShare = (u) => /https?:\/\/www\.facebook\.com\/share\/[a-z]\/([A-Za-z0-9]+)/i.exec(u);


  async function expandFb(url) {
    try {
      const r = await fetch(RESOLVE_API + encodeURIComponent(url));
      if (!r.ok) throw new Error('resolve http ' + r.status);
      const data = await r.json();
      return data.finalUrl || url;
    } catch (e) {
      console.warn('[FacebookEmbed] resolve failed, using original:', e);
      return url;
    }
  }

  async function fetchOG(url) {
    const r = await fetch(OG_API + encodeURIComponent(url));
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('application/json')) {
      console.warn('[FacebookEmbed] OG invalid for:', url, await r.text());
      return null;
    }
    return r.json(); // {title, description, image, url}
  }

  function renderOGCard(data) {
    const wrap = document.createElement('div');
    wrap.className = 'og_preview fb_event';
    wrap.style.cssText = 'border:1px solid #ccc;border-radius:8px;padding:12px;margin-top:10px;max-width:500px;background:#0f111a;color:#fff;';
    wrap.innerHTML =
      '<div style="font-size:13px;opacity:.75;margin-bottom:6px;">Facebook</div>' +
      '<a href="' + (data && data.url ? data.url : '#') + '" target="_blank" ' +
      'style="font-weight:700;font-size:16px;color:#b1a4e8;text-decoration:none;">' +
      (data && data.title ? data.title : 'View on Facebook') +
      '</a>' +
      (data && data.description ? '<p style="margin:8px 0 0;line-height:1.4;">' + data.description + '</p>' : '') +
      (data && data.image ? '<img src="' + data.image + '" loading="lazy" alt="preview" style="width:100%;max-height:320px;object-fit:cover;border-radius:6px;margin-top:10px;">' : '');
    return wrap;
  }

  function ensureFbSdk(contentBlockEl) {
    if (!window.fbAsyncInit) {
      window.fbAsyncInit = function () {
        FB.init({ xfbml: true, version: 'v19.0' });
      };
      if (!document.getElementById('facebook-jssdk')) {
        const js = document.createElement('script');
        js.id = 'facebook-jssdk';
        js.src = 'https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=v19.0';
        document.body.appendChild(js);
      }
    } else {
      if (typeof FB !== 'undefined' && FB.XFBML && FB.XFBML.parse) {
        FB.XFBML.parse(contentBlockEl);
      }
    }
  }

  // --- main scan ---
  const posts = $('div.postbody:contains("facebook.com/"), div.postbody:contains("fb.me/")');

  posts.each(function () {
    const contentBlock = $(this);
    const links = contentBlock.find('a[href*="facebook.com/"], a[href*="fb.me/"]');

    links.each(function () {
      (async () => {
        const $link = $(this);
        const origHref = $link.attr('href') || '';
        if (!origHref) return;

        // avoid re-embed
        if ($link.data('fb-embedded')) return;

        // expand + normalize
        let href = origHref;

        if (isFbShort(href)) href = await expandFb(href);
        href = normFb(href);

        // Обробка /share/* → спершу розкручуємо через /resolve, тоді знову normFb
        const share = isShare(href);
        if (share) {
          try {
            const expanded = await expandFb(href);
            if (expanded) {
              href = normFb(expanded);
              console.log('[FacebookEmbed] share expanded →', href);
            }
          } catch (e) {
            console.warn('[FacebookEmbed] share expand failed', e);
          }
        }

        let matched = false;

        // 1) posts
        const postMatch = isPost(href);
        if (postMatch) {
          const page = postMatch[1];
          const postId = postMatch[2];
          const widgetId = 'facebook-post-' + page + '-' + postId;
          if (contentBlock.find('#' + widgetId).length === 0) {
            $link.after(
              '<div id="' + widgetId + '" class="fb-post" ' +
              'data-href="https://www.facebook.com/' + page + '/posts/' + postId + '" ' +
              'data-width="500" ' +
              'style="margin-top:10px;margin-bottom:10px;"></div>'
            );
            ensureFbSdk(contentBlock[0]);
          }
          $link.data('fb-embedded', true);
          matched = true;
        }

        // 2) videos (/videos/<id> OR /watch?v=<id>)
        if (!matched) {
          const v = isVideo(href);
          if (v) {
            const widgetId = 'facebook-video-' + v.id;
            if (contentBlock.find('#' + widgetId).length === 0) {
              var dataHref = (v.type === 'watch')
                ? 'https://www.facebook.com/watch/?v=' + v.id
                : 'https://www.facebook.com/videos/' + v.id;

              $link.after(
                '<div id="' + widgetId + '" class="fb-video" ' +
                'data-href="' + dataHref + '" ' +
                'data-width="500" ' +
                'style="margin-top:10px;margin-bottom:10px;"></div>'
              );
              ensureFbSdk(contentBlock[0]);
            }
            $link.data('fb-embedded', true);
            matched = true;
          }
        }

        // 3) reels
        if (!matched) {
          const reelMatch = isReel(href);
          if (reelMatch) {
            const reelId = reelMatch[1];
            const widgetId = 'facebook-reel-' + reelId;
            if (contentBlock.find('#' + widgetId).length === 0) {
              $link.after(
                '<div id="' + widgetId + '" class="fb-video" ' +
                'data-href="https://www.facebook.com/reel/' + reelId + '" ' +
                'data-width="500" ' +
                'style="margin-top:10px;margin-bottom:10px;"></div>'
              );
              ensureFbSdk(contentBlock[0]);
            }
            $link.data('fb-embedded', true);
            matched = true;
          }
        }

        // 4) photo (new)
        if (!matched) {
          const phNew = isPhotoNew(href);
          if (phNew) {
            const fbid = phNew[1];
            const widgetId = 'facebook-photo-' + fbid;
            if (contentBlock.find('#' + widgetId).length === 0) {
              $link.after(
                '<div id="' + widgetId + '" class="fb-post" ' +
                'data-href="' + href + '" ' +
                'data-width="500" ' +
                'style="margin-top:10px;margin-bottom:10px;"></div>'
              );
              ensureFbSdk(contentBlock[0]);
            }
            $link.data('fb-embedded', true);
            matched = true;
          }
        }

        // 5) photo (album format)
        if (!matched) {
          const alb = isAlbumPhoto(href);
          if (alb) {
            const photoId = alb[1];
            const widgetId = 'facebook-album-photo-' + photoId;
            if (contentBlock.find('#' + widgetId).length === 0) {
              $link.after(
                '<div id="' + widgetId + '" class="fb-post" ' +
                'data-href="' + href + '" ' +
                'data-width="500" ' +
                'style="margin-top:10px;margin-bottom:10px;"></div>'
              );
              ensureFbSdk(contentBlock[0]);
            }
            $link.data('fb-embedded', true);
            matched = true;
          }
        }

        // 6) story.php / permalink.php → embed as post
        if (!matched) {
          const story = isStory(href) || isPermalink(href);
          if (story) {
            const widgetId = 'facebook-story-' + btoa(href).slice(0, 10);
            if (contentBlock.find('#' + widgetId).length === 0) {
              $link.after(
                '<div id="' + widgetId + '" class="fb-post" ' +
                'data-href="' + href + '" ' +
                'data-width="500" ' +
                'style="margin-top:10px;margin-bottom:10px;"></div>'
              );
              ensureFbSdk(contentBlock[0]);
            }
            $link.data('fb-embedded', true);
            matched = true;
          }
        }

        // 7) events → OG card via proxy (нема офіційного single-event embed)
        if (!matched) {
          const evt = isEvent(href);
          if (evt) {
            const widgetId = 'facebook-event-' + evt[1];
            if (contentBlock.find('#' + widgetId).length === 0) {
              const og = await fetchOG(href);
              const card = renderOGCard(og || { url: href, title: 'View event on Facebook' });
              card.id = widgetId;
              $link.after(card);
            }
            $link.data('fb-embedded', true);
            matched = true;
          }
        }

        // 8) generic fallback
        if (!matched) {
          const widgetId = 'facebook-fallback-' + Math.random().toString(36).substr(2, 8);
          $link.after(
            '<div id="' + widgetId + '" style="margin-top:10px;padding:10px;border:1px solid #ccc;background:#f5f8fa;border-radius:6px;max-width:500px;">' +
            '<img src="https://static.xx.fbcdn.net/rsrc.php/yd/r/hlvibnBVrEb.svg" alt="Facebook" style="height:22px;vertical-align:middle;margin-right:10px;" />' +
            '<a href="' + href + '" target="_blank" style="font-weight:bold;color:#1877f2;text-decoration:none;">' +
            'View on Facebook</a></div>'
          );
          $link.data('fb-embedded', true);
        }
      })();
    });
  });
});
