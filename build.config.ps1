# build.config.ps1
# DeepSeek Harness Windows 桌面打包器的可选配置。
# 优先级：命令行参数 > 本配置文件 > 脚本内默认值。
# 不改这个文件也能直接使用默认配置。

# 上游 DeepSeek Harness 仓库地址。构建时会自动 git clone/fetch 到 .cache/upstream。
$UpstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'

# 默认固定到已通过完整 Windows 打包验证的 DSH 0.1.6-alpha.2 提交。
# 本地构建和 GitHub 发布共用此配置；升级上游前应先验证兼容性。
$UpstreamRef = 'ddefc45fbc7f8e46dd73185e68295696d1297887'
# 可通过命令行或 GitHub Actions 的 upstream_ref 临时覆盖。
# $UpstreamRef = 'v0.1.0'
# $UpstreamRef = 'main'
