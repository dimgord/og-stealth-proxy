$(function () {
  console.log("[TelegramEmbed] Scanning posts for t.me links (iframe version)...");

  const posts = $('div.postbody:contains("t.me/")');

  posts.each(function () {
    const contentBlock = $(this);
    // Знаходимо всі лінки t.me у цьому postbody
    const links = contentBlock.find('a[href*="t.me/"]');

    links.each(function () {
      const $link = $(this);
      const href = $link.attr('href');
      const match = href.match(/https?:\/\/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);

      if (!match) return;

      const channel = match[1];
      const messageId = match[2];
      const widgetId = "telegram-iframe-" + channel + "-" + messageId;
      const iframeURL = "https://t.me/" + channel + "/" + messageId + "?embed=1";

      // щоб не дублювати, перевіряємо
      if (contentBlock.find("#" + widgetId).length > 0) return;

      const iframeHTML = `
        <iframe id="${widgetId}" src="${iframeURL}"
          width="90%" height="500" frameborder="0" scrolling="yes"
          style="border: 1px solid #ccc; border-radius: 6px; margin-top: 10px; max-width: 500px; width: 90%; display: block; margin-left: auto; margin-right: auto;">
        </iframe>`;

      // Додаємо iframe одразу після лінка
      $link.after(iframeHTML);

      setTimeout(function () {
        const iframe = document.getElementById(widgetId);
        const iframeVisible = !!iframe;

        if (!iframeVisible) {
          console.warn("[TelegramEmbed] iframe missing. Showing fallback for " + channel + "/" + messageId);
          const fallback = `
            <div style="margin-top:10px; padding:10px; border:1px solid #ccc; background:#f5f8fa;">
              <img src="https://telegram.org/img/t_logo.svg" alt="Telegram" style="height:20px; vertical-align:middle; margin-right:10px;" />
              <a href="https://t.me/${channel}/${messageId}" target="_blank" style="font-weight:bold; color:#0088cc; text-decoration:none;">
                View Telegram Post</a>
            </div>`;
          $link.after(fallback);
        } else {
          console.log("[TelegramEmbed] iframe embed visible for " + channel + "/" + messageId);
          const height = iframe.clientHeight;
          console.log("[TelegramEmbed] Detected iframe height:", height);

          if (height < 600) {
            iframe.style.height = "400px";
            console.log("[TelegramEmbed] Iframe too short — applying fallback height = 400px");
          }
        }
      }, 2000);
    });
  });
});
