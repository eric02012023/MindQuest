MindQuest CSS structure

- global.css is no longer loaded by views/partials/head.ejs.
- The former global/base styles were copied into each individual CSS file so a page or dashboard section can be redesigned without affecting the other pages.
- public/, auth/, student/, tutor/, admin/, assistant-admin/ contain the CSS files that should be edited per page/role/section.
- Each page should use its matching CSS file through views/partials/head.ejs.
- Dashboard pages get a wrapper class automatically from views/shells/dashboard.ejs, then load the matching role CSS and section CSS.
