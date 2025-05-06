$(function () {
  console.log("[TelegramEmbed] Scanning posts for t.me links (iframe version)...");

  const posts = $('div.postbody:contains("t.me/")');

  posts.each(function () {
    const contentBlock = $(this);
    const matches = contentBlock.text().matchAll(/https?:\/\/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/g);

    for (const match of matches) {
      const channel = match[1];
      const messageId = match[2];
      const widgetId = "telegram-iframe-" + channel + "-" + messageId;
      const iframeURL = "https://t.me/" + channel + "/" + messageId + "?embed=1";

      console.log("[TelegramEmbed] Trying iframe for " + channel + "/" + messageId);

      // щоб не дублювати, перевіряємо
      if (contentBlock.find("#" + widgetId).length > 0) continue;

      const iframeHTML = `
        <iframe id="${widgetId}" src="${iframeURL}"
          width="100%" height="600" frameborder="0" scrolling="yes"
          style="border: 1px solid #ccc; border-radius: 6px; margin-top: 10px; max-width: 700px; width: 100%; display: block; margin-left: auto; margin-right: auto;">
        </iframe>`;

      contentBlock.append(iframeHTML);

      // fallback або адаптивне регулювання
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
          contentBlock.append(fallback);
        } else {
          console.log("[TelegramEmbed] iframe embed visible for " + channel + "/" + messageId);
          const height = iframe.clientHeight;
          console.log("[TelegramEmbed] Detected iframe height:", height);

          if (height < 600) {
            iframe.style.height = "600px";
            console.log("[TelegramEmbed] Iframe too short — applying fallback height = 600px");
          }
        }
      }, 2000);
    }
  });
});
