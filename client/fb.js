$(function () {
  console.log("[FacebookEmbed] Scanning posts for facebook.com/fb.me links...");

  const PROXY = 'https://www.dimgord.cc';
  const RESOLVE_API = PROXY + '/resolve?url=';
  const OG_API = PROXY + '/og-proxy?url=';
  const CAN_EMB_API = PROXY + '/can-embed-fb?href=';

  // Чи це jQuery-об'єкт?
  function isJQ(x){ return !!(x && (x.jquery || (window.jQuery && x instanceof window.jQuery))); }
// Витягнути DOM-ноду з jQuery або повернути як є
  function toNode(x){ return isJQ(x) ? x[0] : x; }
// Створити ноду з HTML-рядка
  function htmlToNode(html){
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
// Перевірити, чи елемент з id вже існує всередині contentBlock (jQ або DOM)
  function hasInBlock(contentBlock, id){
    const root = isJQ(contentBlock) ? contentBlock[0] : (contentBlock || document);
    return !!root.querySelector('#' + id);
  }
// Вставити ПІСЛЯ посилання (працює і з jQ, і без)
  function insertAfterLink(link, htmlOrNode){
    const el = (typeof htmlOrNode === 'string') ? htmlToNode(htmlOrNode) : htmlOrNode;
    if (isJQ(link)) { link.after(el); return el; }
    const node = toNode(link);
    if (node && node.parentNode){
      if (node.insertAdjacentElement) node.insertAdjacentElement('afterend', el);
      else node.parentNode.insertBefore(el, node.nextSibling);
    }
    return el;
  }

// ====== DETECTORS ======
  const isVideo = (u) => {
    const s = String(u || '');
    let m;
    // 1) watch?v=<id>
    m = /^https?:\/\/(?:www\.)?facebook\.com\/watch\/?\?v=(\d+)/i.exec(s);
    if (m) return {id: m[1], type: 'watch'};
    // 2) <user>/videos/<slug>/<id>  або  <user>/videos/<id>
    m = /^https?:\/\/(?:www\.)?facebook\.com\/([^\/?#]+)\/videos\/(?:[^\/?#]+\/)?(\d+)/i.exec(s);
    if (m) return {id: m[2], type: 'user', user: m[1]};
    // 3) /videos/<id>
    m = /^https?:\/\/(?:www\.)?facebook\.com\/videos\/(\d+)/i.exec(s);
    if (m) return {id: m[1], type: 'videos'};
    return null;
  };

  const isReel = (u) => /^https?:\/\/(?:www\.)?facebook\.com\/reel\/([A-Za-z0-9]+)/i.exec(String(u || ''));

  const isFbPost = (u) => {
    const s = String(u || '');
    let m;
    // groups/<group>/posts/<id>
    m = /^https?:\/\/(?:www\.)?facebook\.com\/groups\/[^\/?#]+\/posts\/(\d+)/i.exec(s);
    if (m) return {type: 'post', id: m[1], href: s};
    // user/page posts з опційним slug
    m = /^https?:\/\/(?:www\.)?facebook\.com\/([^\/?#]+)\/posts\/(?:[^\/?#]+\/)?(\d+)/i.exec(s);
    if (m) return { type: 'post', id: m[2], href: s, user: m[1] };
    // permalink.php?story_fbid=...
    m = /^https?:\/\/(?:www\.)?facebook\.com\/permalink\.php\?[^#]*\bstory_fbid=(\d+)/i.exec(s);
    if (m) return {type: 'post', id: m[1], href: s};
    // story.php?story_fbid=...
    m = /^https?:\/\/(?:www\.)?facebook\.com\/story\.php\?[^#]*\bstory_fbid=(\d+)/i.exec(s);
    if (m) return {type: 'post', id: m[1], href: s};
    // photo/?fbid=... — теж рендеримо як пост (офіційного photo-embed немає)
    m = /^https?:\/\/(?:www\.)?facebook\.com\/photo\/\?[^#]*\bfbid=(\d+)/i.exec(s);
    if (m) return {type: 'post', id: m[1], href: s};
    return null;
  };

// «класичні» фото-URL
  const isPhotoNew = (u) => /^https?:\/\/(?:www\.)?facebook\.com\/photo\/\?[^#]*\bfbid=(\d+)/i.exec(String(u || ''));
  const isAlbumPhoto = (u) => {
    const s = String(u || '');
    // photo.php?fbid=<id>
    let m = /^https?:\/\/(?:www\.)?facebook\.com\/photo\.php\?[^#]*\bfbid=(\d+)/i.exec(s);
    if (m) return m;
    // <user>/photos/<anything>/<id>
    m = /^https?:\/\/(?:www\.)?facebook\.com\/[^\/?#]+\/photos\/[^\/?#]+\/(\d+)/i.exec(s);
    return m;
  };

  const isStory = (u) => /^https?:\/\/(?:www\.)?facebook\.com\/story\.php\?/i.test(String(u || ''));
  const isPermalink = (u) => /^https?:\/\/(?:www\.)?facebook\.com\/permalink\.php\?/i.test(String(u || ''));
  const isEvent = (u) => /^https?:\/\/(?:www\.)?facebook\.com\/events\/(\d+)/i.exec(String(u || ''));


  // --- helpers ---
  const isFbShort = (u) => /^https?:\/\/fb\.me\/.+/i.test(u);
  const normFb = (u) => u.replace(/^https?:\/\/m\.facebook\.com/i, 'https://www.facebook.com');

  const isPost = (u) => /https?:\/\/www\.facebook\.com\/([^\/?]+)\/posts\/(\d+)/i.exec(u);

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
        FB.init({xfbml: true, version: 'v19.0'});
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

  // async function tryEmbedFbPost(href, $link, contentBlock) {
  //   const r = await fetch(CAN_EMB_API + encodeURIComponent(href)).then(x=>x.json()).catch(()=>({ok:false}));
  //   if (r.ok) {
  //     // вставляємо fb-post
  //     $link.after('<div class="fb-post" data-href="'+href+'" data-width="500" style="margin:10px 0"></div>');
  //     ensureFbSdk(contentBlock[0]);
  //   } else {
  //     // fallback: OG‑картка
  //     const og = await fetchOG(href);
  //     const card = renderOGCard(og || { url: href });
  //     $link.after(card);
  //   }
  // }
  // async function tryEmbedFbPost(href, $link, contentBlock) {
  //   const url = CAN_EMB_API + encodeURIComponent(href) + '&origin=' + encodeURIComponent(location.origin);
  //   const r = await fetch(url).then(x => x.json()).catch(() => ({ ok: false }));
  //
  //   if (r.ok && r.src) {
  //     const widgetId = 'facebook-post-iframe-' + btoa(r.cleanHref || href).slice(0, 10);
  //     if (contentBlock.find('#' + widgetId).length === 0 || 1) {
  //       const $wrap = $('<div/>', { id: widgetId, class: 'fb-post-iframe', css: { margin: '10px 0' } });
  //       $wrap.html(0 || (
  //         '<iframe src="' + r.text + '" width="500" height="680" style="border:none;overflow:hidden" ' +
  //         'scrolling="no" frameborder="0" allow="encrypted-media; picture-in-picture; web-share; clipboard-write"></iframe>'
  //       ));
  //       $link.after($wrap);
  //     }
  //     $link.data('fb-embedded', true);
  //     return true;
  //   }
  //
  //   // fallback → OG‑картка
  //   const og = await fetchOG(r.cleanHref || href);
  //   const card = renderOGCard(og || { url: href });
  //   $link.after(card);
  //   $link.data('fb-embedded', true);
  //   return false;
  // }

  async function tryEmbedFbPost(href, $link, contentBlock) {
    const url = CAN_EMB_API + encodeURIComponent(href) + '&origin=' + encodeURIComponent(location.origin);
    const r = await fetch(url).then(x => x.json()).catch(() => ({ ok:false }));

    if (r.ok && r.src) {
      const clean = r.cleanHref || href;
      const widgetId = 'facebook-post-iframe-' + btoa(clean).slice(0,10);

      if (!hasInBlock(contentBlock, widgetId)) {
        const html = r.html || (
          '<div id="'+widgetId+'" class="fb-post-iframe" style="margin:10px 0">' +
          '<iframe src="'+r.src+'" width="500" height="680" style="border:none;overflow:hidden" ' +
          'scrolling="no" frameborder="0" allow="encrypted-media; picture-in-picture; web-share; clipboard-write"></iframe>' +
          '</div>'
        );
        insertAfterLink($link, html);
      }
      // помітити, що вже оброблено (і для jQ, і без)
      if (isJQ($link)) { $link.data('fb-embedded', true); } else { $link.dataset.fbEmbedded = '1'; }
      return true;
    }

    // fallback → OG‑картка
    const og = await fetchOG(href);
    const card = renderOGCard(og || { url: href });
    // card може бути DOM-нода або HTML-string — обидва варіанти працюють
    insertAfterLink($link, card);
    if (isJQ($link)) { $link.data('fb-embedded', true); } else { $link.dataset.fbEmbedded = '1'; }
    return false;
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
        let href = normFb(origHref);

        // if (isFbShort(href)) href = await expandFb(href);
        // href = normFb(href);

        // Обробка /share/* → спершу розкручуємо через /resolve, тоді знову normFb
        const share = isShare(href);
        // only share for now, if 'normal' links - leave it to the forum's processor
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

          let matched = false;

//           // 1) videos (/videos/<id>, <user id>/videos/<id> OR /watch?v=<id>)
//           const v = isVideo(href);
//           if (v) {
//             const widgetId = 'facebook-video-' + v.id;
//             if (contentBlock.find('#' + widgetId).length === 0) {
//               let dataHref;
//               if (v.type === 'watch') {
//                 dataHref = 'https://www.facebook.com/watch/?v=' + v.id;
//               } else if (v.type === 'user') {
//                 // user-case: будуємо URL на сторінці користувача/сторінки
//                 dataHref = 'https://www.facebook.com/' + encodeURIComponent(v.user) + '/videos/' + v.id;
//               } else {
//                 // bare /videos/<id>
//                 dataHref = 'https://www.facebook.com/videos/' + v.id;
//               }
//
//               $link.after(
//                 '<div id="' + widgetId + '" class="fb-video" ' +
//                 'data-href="' + dataHref + '" ' +
//                 'data-width="500" ' +
//                 'style="margin-top:10px;margin-bottom:10px;"></div>'
//               );
//               ensureFbSdk(contentBlock[0]);
//             }
//             $link.data('fb-embedded', true);
//             matched = true;
//           }
//
// // 2) ⬇️ якщо це не відео — спробуй пост
//           if (!matched) {
//             const p = isFbPost(href);
//             if (p) {
//               const widgetId = 'facebook-post-' + p.id;
//               if (contentBlock.find('#' + widgetId).length === 0) {
//                 // для постів FB використовує <div class="fb-post" data-href="...">
//                 $link.after(
//                   '<div id="' + widgetId + '" class="fb-post" ' +
//                   'data-href="' + p.href + '" data-width="500" ' +
//                   'style="margin-top:10px;margin-bottom:10px;"></div>'
//                 );
//                 ensureFbSdk(contentBlock[0]);
//               }
//               $link.data('fb-embedded', true);
//               matched = true;
//             }
//           }
//
//           // 3) старі posts
//           if (!matched) {
//             const postMatch = isPost(href);
//             if (postMatch) {
//               const page = postMatch[1];
//               const postId = postMatch[2];
//               const widgetId = 'facebook-post-' + page + '-' + postId;
//               if (contentBlock.find('#' + widgetId).length === 0) {
//                 $link.after(
//                   '<div id="' + widgetId + '" class="fb-post" ' +
//                   'data-href="https://www.facebook.com/' + page + '/posts/' + postId + '" ' +
//                   'data-width="500" ' +
//                   'style="margin-top:10px;margin-bottom:10px;"></div>'
//                 );
//                 ensureFbSdk(contentBlock[0]);
//               }
//               $link.data('fb-embedded', true);
//               matched = true;
//             }
//           }
//
//           // 3) reels
//           if (!matched) {
//             const reelMatch = isReel(href);
//             if (reelMatch) {
//               const reelId = reelMatch[1];
//               const widgetId = 'facebook-reel-' + reelId;
//               if (contentBlock.find('#' + widgetId).length === 0) {
//                 $link.after(
//                   '<div id="' + widgetId + '" class="fb-video" ' +
//                   'data-href="https://www.facebook.com/reel/' + reelId + '" ' +
//                   'data-width="500" ' +
//                   'style="margin-top:10px;margin-bottom:10px;"></div>'
//                 );
//                 ensureFbSdk(contentBlock[0]);
//               }
//               $link.data('fb-embedded', true);
//               matched = true;
//             }
//           }
//
//           // 4) photo (new)
//           if (!matched) {
//             const phNew = isPhotoNew(href);
//             if (phNew) {
//               const fbid = phNew[1];
//               const widgetId = 'facebook-photo-' + fbid;
//               if (contentBlock.find('#' + widgetId).length === 0) {
//                 $link.after(
//                   '<div id="' + widgetId + '" class="fb-post" ' +
//                   'data-href="' + href + '" ' +
//                   'data-width="500" ' +
//                   'style="margin-top:10px;margin-bottom:10px;"></div>'
//                 );
//                 ensureFbSdk(contentBlock[0]);
//               }
//               $link.data('fb-embedded', true);
//               matched = true;
//             }
//           }
//
//           // 5) photo (album format)
//           if (!matched) {
//             const alb = isAlbumPhoto(href);
//             if (alb) {
//               const photoId = alb[1];
//               const widgetId = 'facebook-album-photo-' + photoId;
//               if (contentBlock.find('#' + widgetId).length === 0) {
//                 $link.after(
//                   '<div id="' + widgetId + '" class="fb-post" ' +
//                   'data-href="' + href + '" ' +
//                   'data-width="500" ' +
//                   'style="margin-top:10px;margin-bottom:10px;"></div>'
//                 );
//                 ensureFbSdk(contentBlock[0]);
//               }
//               $link.data('fb-embedded', true);
//               matched = true;
//             }
//           }
//
//           // 6) story.php / permalink.php → embed as post
//           if (!matched) {
//             const story = isStory(href) || isPermalink(href);
//             if (story) {
//               const widgetId = 'facebook-story-' + btoa(href).slice(0, 10);
//               if (contentBlock.find('#' + widgetId).length === 0) {
//                 $link.after(
//                   '<div id="' + widgetId + '" class="fb-post" ' +
//                   'data-href="' + href + '" ' +
//                   'data-width="500" ' +
//                   'style="margin-top:10px;margin-bottom:10px;"></div>'
//                 );
//                 ensureFbSdk(contentBlock[0]);
//               }
//               $link.data('fb-embedded', true);
//               matched = true;
//             }
//           }
//
//           // 7) events → OG card via proxy (нема офіційного single-event embed)
//           if (!matched) {
//             const evt = isEvent(href);
//             if (evt) {
//               const widgetId = 'facebook-event-' + evt[1];
//               if (contentBlock.find('#' + widgetId).length === 0) {
//                 const og = await fetchOG(href);
//                 const card = renderOGCard(og || {url: href, title: 'View event on Facebook'});
//                 card.id = widgetId;
//                 $link.after(card);
//               }
//               $link.data('fb-embedded', true);
//               matched = true;
//             }
//           }
//
//           // 8) generic fallback
//           if (!matched) {
//             const widgetId = 'facebook-fallback-' + Math.random().toString(36).substr(2, 8);
//             $link.after(
//               '<div id="' + widgetId + '" style="margin-top:10px;padding:10px;border:1px solid #ccc;background:#f5f8fa;border-radius:6px;max-width:500px;">' +
//               '<img src="https://static.xx.fbcdn.net/rsrc.php/yd/r/hlvibnBVrEb.svg" alt="Facebook" style="height:22px;vertical-align:middle;margin-right:10px;" />' +
//               '<a href="' + href + '" target="_blank" style="font-weight:bold;color:#1877f2;text-decoration:none;">' +
//               'View on Facebook</a></div>'
//             );
//             $link.data('fb-embedded', true);
//           }


////////////////////////// нове /////////////////////////
          if (!matched) {
            const v = isVideo(href);
            if (v) {
              const widgetId = 'facebook-video-' + v.id;
              if (contentBlock.find('#' + widgetId).length === 0) {
                let dataHref;
                if (v.type === 'watch') {
                  dataHref = 'https://www.facebook.com/watch/?v=' + v.id;
                } else if (v.type === 'user') {
                  dataHref = 'https://www.facebook.com/' + encodeURIComponent(v.user) + '/videos/' + v.id;
                } else {
                  dataHref = 'https://www.facebook.com/videos/' + v.id;
                }
                $link.after(
                  '<div id="' + widgetId + '" class="fb-video" ' +
                  'data-href="' + dataHref + '" data-width="500" ' +
                  'style="margin-top:10px;margin-bottom:10px;"></div>'
                );
                ensureFbSdk(contentBlock[0]);
              }
              $link.data('fb-embedded', true);
              matched = true;
            }
          }

          if (!matched) {
            const reel = isReel(href);
            if (reel) {
              const reelId = reel[1];
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

          if (!matched) {
            const p = isFbPost(href);
            if (p) {
              // before using href in data-href
              const cleanHref = p.href
                .replace(/(\?|&)rdid=[^&#]*/gi, '')
                .replace(/(\?|&)share_url=[^&#]*/gi, '')
                .replace(/(\?|&)m=1\b/gi, '')
                .replace(/[#?]&?$/,''); // зайві хвости
              tryEmbedFbPost(cleanHref, $link, contentBlock);
              // if (contentBlock.find('#' + widgetId).length === 0) {
              //   $link.after(
              //     '<div id="' + widgetId + '" class="fb-post" ' +
              //     'data-href="' + cleanHref + '" data-width="500" ' +
              //     'style="margin-top:10px;margin-bottom:10px;"></div>'
              //   );
              //   ensureFbSdk(contentBlock[0]);
              // }
              // $link.data('fb-embedded', true);
              matched = true;
            }
          }

          // «класичні» фото — вбудовуємо як fb-post із оригінальним href
          if (!matched) {
            const phNew = isPhotoNew(href);
            if (phNew) {
              const fbid = phNew[1];
              const widgetId = 'facebook-photo-' + fbid;
              if (contentBlock.find('#' + widgetId).length === 0) {
                $link.after(
                  '<div id="' + widgetId + '" class="fb-post" ' +
                  'data-href="' + href + '" data-width="500" ' +
                  'style="margin-top:10px;margin-bottom:10px;"></div>'
                );
                ensureFbSdk(contentBlock[0]);
              }
              $link.data('fb-embedded', true);
              matched = true;
            }
          }

          if (!matched) {
            const alb = isAlbumPhoto(href);
            if (alb) {
              const photoId = alb[1];
              const widgetId = 'facebook-album-photo-' + photoId;
              if (contentBlock.find('#' + widgetId).length === 0) {
                $link.after(
                  '<div id="' + widgetId + '" class="fb-post" ' +
                  'data-href="' + href + '" data-width="500" ' +
                  'style="margin-top:10px;margin-bottom:10px;"></div>'
                );
                ensureFbSdk(contentBlock[0]);
              }
              $link.data('fb-embedded', true);
              matched = true;
            }
          }

          // story.php / permalink.php → embed as post
          if (!matched) {
            if (isStory(href) || isPermalink(href)) {
              const widgetId = 'facebook-story-' + btoa(href).slice(0, 10);
              if (contentBlock.find('#' + widgetId).length === 0) {
                $link.after(
                  '<div id="' + widgetId + '" class="fb-post" ' +
                  'data-href="' + href + '" data-width="500" ' +
                  'style="margin-top:10px;margin-bottom:10px;"></div>'
                );
                ensureFbSdk(contentBlock[0]);
              }
              $link.data('fb-embedded', true);
              matched = true;
            }
          }

          // events → нема офіційного single-event embed → малюємо OG‑картку
          if (!matched) {
            const evt = isEvent(href);
            if (evt) {
              const widgetId = 'facebook-event-' + evt[1];
              if (contentBlock.find('#' + widgetId).length === 0) {
                const og = await fetchOG(href);
                const card = renderOGCard(og || {url: href, title: 'View event on Facebook'});
                card.id = widgetId;
                $link.after(card);
              }
              $link.data('fb-embedded', true);
              matched = true;
            }

            // generic fallback
            if (!matched) {
              const widgetId = 'facebook-fallback-' + Math.random().toString(36).substr(2, 8);
              $link.after(
                '<div id="' + widgetId + '" style="margin-top:10px;padding:10px;border:1px solid #ccc;background:#f5f8fa;border-radius:6px;max-width:500px;">' +
                '<img src="https://static.xx.fbcdn.net/rsrc.php/yd/r/hlvibnBVrEb.svg" alt="Facebook" style="height:22px;vertical-align:middle;margin-right:10px;" />' +
                '<a href="' + href + '" target="_blank" style="font-weight:bold;color:#1877f2;text-decoration:none;">' +
                'Could not expand this link, please view it on Facebook</a></div>'
              );
              $link.data('fb-embedded', true);
            }
          }
////////////////////////// кінець нового ////////////////
        } // only share, if 'normal' links - leave it to the forum's processor
      })();
    });
  });
});
