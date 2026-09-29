# Google Apps Script 迁移步骤

1. 打开 https://script.google.com/create ，创建空白 Apps Script 项目。
2. 将本目录 `Code.gs` 的全部内容粘贴到 Apps Script 编辑器的 `Code.gs`。
3. 把顶部的 `NOTIFY_EMAIL = 'CHANGE_ME@example.com'` 改成你的接收邮箱。
4. 保存项目，名称可设为 `Instagram Update Monitor`。
5. 在函数下拉框选择 `sendTestEmail`，点击“运行”，按 Google 提示完成授权。确认收到测试邮件。
6. 再选择 `setupOnce`，点击“运行”。它会：
   - 导入 GitHub 现有已读状态；
   - 创建一个每 5 分钟执行的 `monitorInstagram` 时间触发器；
   - 立刻执行一次监控。
7. 左侧“触发器”页面确认存在 `monitorInstagram` 的时间驱动触发器。
8. 左侧“执行记录”检查首次运行是否成功，并确认没有重复/错误通知。
9. Google Apps Script 监控稳定后，再关闭 GitHub Actions 的 `schedule`，保留手动运行作为备用，避免重复邮件。

邮件中的发布时间会使用 `Asia/Shanghai` 显示为北京时间（UTC+8）。
