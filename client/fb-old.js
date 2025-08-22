$(function () {
  console.log("[FacebookEmbed] Scanning posts for facebook.com links...");

  const posts = $('div.postbody:contains("facebook.com/")');

  posts.each(function () {
    const contentBlock = $(this);
    const links = contentBlock.find('a[href*="facebook.com/"]');

    links.each(function () {
      const $link = $(this);
      const href = $link.attr('href');
      let matched = false;

      // 1. Facebook post
      const isPost = href.match(/https?:\/\/www\.facebook\.com\/([^\/?]+)\/posts\/(\d+)/);
      if (isPost) {
        const page = isPost[1];
        const postId = isPost[2];
        const widgetId = "facebook-post-" + page + "-" + postId;
        if (contentBlock.find("#" + widgetId).length > 0) return;
        $link.after(`
          <div id="${widgetId}" class="fb-post"
               data-href="https://www.facebook.com/${page}/posts/${postId}"
               data-width="500"
               style="margin-top:10px; margin-bottom:10px;">
          </div>
        `);
        matched = true;
      }

      // 2. Facebook video
      const isVideo = href.match(/https?:\/\/www\.facebook\.com\/([^\/?]+)\/videos\/(\d+)/);
      if (isVideo) {
        const page = isVideo[1];
        const videoId = isVideo[2];
        const widgetId = "facebook-video-" + page + "-" + videoId;
        if (contentBlock.find("#" + widgetId).length > 0) return;
        $link.after(`
          <div id="${widgetId}" class="fb-video"
               data-href="https://www.facebook.com/${page}/videos/${videoId}"
               data-width="500"
               style="margin-top:10px; margin-bottom:10px;">
          </div>
        `);
        matched = true;
      }

      // 3. Facebook reel (через fb-video, якщо працює)
      const isReel = href.match(/https?:\/\/www\.facebook\.com\/reel\/(\d+)/);
      if (isReel) {
        const reelId = isReel[1];
        const widgetId = "facebook-reel-" + reelId;
        if (contentBlock.find("#" + widgetId).length > 0) return;
        $link.after(`
          <div id="${widgetId}" class="fb-video"
               data-href="https://www.facebook.com/reel/${reelId}"
               data-width="500"
               style="margin-top:10px; margin-bottom:10px;">
          </div>
        `);
        matched = true;
      }

      // 4. Facebook photo (новий формат)
      const isPhoto = href.match(/https?:\/\/www\.facebook\.com\/photo\/\?fbid=(\d+)/);
      if (isPhoto) {
        const fbid = isPhoto[1];
        const widgetId = "facebook-photo-" + fbid;
        if (contentBlock.find("#" + widgetId).length > 0) return;
        $link.after(`
          <div id="${widgetId}" class="fb-post"
               data-href="${href}"
               data-width="500"
               style="margin-top:10px; margin-bottom:10px;">
          </div>
        `);
        matched = true;
      }

      // 5. Facebook photo (старий альбомний формат)
      const isAlbumPhoto = href.match(/https?:\/\/www\.facebook\.com\/[^\/]+\/photos\/a\.[^\/]+\/(\d+)/);
      if (isAlbumPhoto) {
        const photoId = isAlbumPhoto[1];
        const widgetId = "facebook-album-photo-" + photoId;
        if (contentBlock.find("#" + widgetId).length > 0) return;
        $link.after(`
          <div id="${widgetId}" class="fb-post"
               data-href="${href}"
               data-width="500"
               style="margin-top:10px; margin-bottom:10px;">
          </div>
        `);
        matched = true;
      }

      // Fallback для будь-якого facebook.com лінка, який не розпізнали
      if (!matched) {
        const widgetId = "facebook-fallback-" + Math.random().toString(36).substr(2, 8);
        $link.after(`
          <div id="${widgetId}" style="margin-top:10px; padding:10px; border:1px solid #ccc; background:#f5f8fa; border-radius:6px; max-width:500px;">
            <img src="https://static.xx.fbcdn.net/rsrc.php/yd/r/hlvibnBVrEb.svg" alt="Facebook" style="height:22px; vertical-align:middle; margin-right:10px;" />
            <a href="${href}" target="_blank" style="font-weight:bold; color:#1877f2; text-decoration:none;">
              View on Facebook
            </a>
          </div>
        `);
      }

      // Ініціалізація Facebook SDK (один раз на сторінку)
      if (!window.fbAsyncInit) {
        window.fbAsyncInit = function() {
          FB.init({
            xfbml: true,
            version: 'v19.0'
          });
        };
        if (!document.getElementById('facebook-jssdk')) {
          const js = document.createElement('script');
          js.id = 'facebook-jssdk';
          js.src = "https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=v19.0";
          document.body.appendChild(js);
        }
      } else {
        if (typeof FB !== "undefined" && FB.XFBML && FB.XFBML.parse) {
          FB.XFBML.parse(contentBlock[0]);
        }
      }
    });
  });
});
