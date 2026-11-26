/**
 * 仓库归属（唯一出口）
 * ====================
 * GitHub 的 roost 仓库在组织 `roost-qq` 下，Gitee 镜像仍在 `tdcq9594`
 * 个人账号下。两边 owner 不同，所有 Gitee 地址必须经 giteeRepoOf() 换算，
 * 不要在别处把 GitHub slug 直接拼进 gitee.com。
 *
 * 组织或账号改名只改这里；调用方一律引用常量。
 */
export const GH_OWNER = 'roost-qq';
export const GITEE_OWNER = 'tdcq9594';

/**
 * 本仓（dsh-roost 自己）。
 *
 * 必须单列：`docs/` 下的文件（教程、API.md）只存在于这一层，框架仓
 * qq-bot-roost 里没有同名路径。曾经把教程链接写成 FW_REPO，点过去是 404——
 * 「本项目」和「框架」是两个仓，拼错时 URL 看起来完全正常。
 */
export const SELF_REPO = `${GH_OWNER}/dsh-roost`;
export const GITEE_SELF_REPO = `${GITEE_OWNER}/dsh-roost`;

export const FW_REPO = `${GH_OWNER}/qq-bot-roost`;
export const GITEE_FW_REPO = `${GITEE_OWNER}/qq-bot-roost`;
export const EXT_REPO = `${GH_OWNER}/qq-bot-roost-plugins`;
export const PERSONA_REPO = `${GH_OWNER}/dsh-roost-personas`;
export const GITEE_PERSONA_REPO = `${GITEE_OWNER}/dsh-roost-personas`;

/** GitHub slug（owner/name）→ Gitee 同名仓库的 slug */
export function giteeRepoOf(repo) {
  const slug = String(repo ?? '');
  return slug.startsWith(`${GH_OWNER}/`)
    ? `${GITEE_OWNER}/${slug.slice(GH_OWNER.length + 1)}`
    : slug;
}
