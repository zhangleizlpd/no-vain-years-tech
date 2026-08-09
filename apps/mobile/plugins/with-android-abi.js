// 本地 config plugin：按 EAS build profile 限制 Android ABI。
//
// 背景（2026-06-12）：Mate50（arm64-v8a）是日常真机验证的唯一目标，而 EAS 默认
// 构 universal apk —— armeabi-v7a / arm64-v8a / x86 / x86_64 四套 ABI 全打，dev-client
// 云构建慢、apk 大。把 development profile 收窄成只构 arm64-v8a → 体积与构建时间砍一大半。
//
// 为何走 config plugin 改 gradle.properties，而非 eas.json 的 env var：
//   expo prebuild 会在 android/gradle.properties 写死 `reactNativeArchitectures=...`，
//   按 Gradle 属性优先级，gradle.properties 文件值**压过** ORG_GRADLE_PROJECT_* env var
//   （2026-06-12 核实 Gradle build_environment 优先级：CLI -P > 系统属性 > gradle.properties
//   > 环境变量），故纯 env 覆盖静默失效。withGradleProperties 直接改 gradle 真正读的那行，
//   确定生效。
//
// 作用域：仅当 EAS_BUILD_PROFILE === 'development' 时收窄（EAS 构建期在 builder 上内置注入
//   该 env，比用户自定义 env 更可靠）。preview / production，以及本地无 EAS 的 prebuild
//   都不命中 → 保持 prebuild 默认四 ABI，绝不影响发版包的设备兼容性。
const { withGradleProperties } = require('@expo/config-plugins');

const ARCH_PROPERTY = 'reactNativeArchitectures';

const withAndroidAbi = (config, props) => {
  const archs = (props && props.archs) || ['arm64-v8a'];
  const onlyProfile = (props && props.profile) || 'development';

  // 只在指定 EAS build profile 下收窄 ABI；其余场景（含本地 prebuild）保持默认。
  if (process.env.EAS_BUILD_PROFILE !== onlyProfile) {
    return config;
  }

  return withGradleProperties(config, (config) => {
    const value = archs.join(',');
    const existing = config.modResults.find(
      (item) => item.type === 'property' && item.key === ARCH_PROPERTY,
    );
    if (existing) {
      existing.value = value;
    } else {
      config.modResults.push({ type: 'property', key: ARCH_PROPERTY, value });
    }
    return config;
  });
};

module.exports = withAndroidAbi;
