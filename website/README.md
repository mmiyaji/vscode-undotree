# vscode-undotree introduction website

Japanese / English single-page introduction, based on the second selected mock with a documentation sidebar. The branching-history explanation is retained from the initial implementation. The topbar contains a language dropdown and light/dark icon toggle; preferences persist locally. Actual extension screenshots are copied into `public/assets`. Installation links open the published Visual Studio Marketplace listing for `mmiyaji.vscode-undotree`.

Run `npm install`, then `npm run dev`. `npm run build` creates the static site in `dist/client` and the bundled hosting worker in `dist/server`. The extension has no dependency on this site's packages.

## Cloudflare Pages

Production domain: https://undotree.ruhenheim.org/ . Pages project: `undotree`.

Following the neighboring SongBrief project, `.github/workflows/cloudflare-pages.yml` builds and deploys website changes on `main` (or manual dispatch). It requires repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, scoped to the account with Pages edit permission. Deploy only `website/dist/client`; the generated Sites worker is not needed by Pages. Configure the custom domain on the Pages project.

For a local deployment, run `npm run build`, then `npx wrangler pages deploy dist/client --project-name=undotree --branch=main` with authenticated Wrangler. `wrangler.jsonc` declares the Pages output folder. Local QA workspaces, source files, and credentials are not part of the deployed output.

Initial publication was deployed locally on 2026-11-15 (JST): deployment `d5918f9f-7dd7-4e68-b8fe-c1218c13854a`, https://d5918f9f.undotree.pages.dev . The custom domain is https://undotree.ruhenheim.org/ and is serving HTTPS successfully. Automatic deployment requires the two repository secrets. Without them, Actions still builds and verifies the site, then skips deployment with a warning.
