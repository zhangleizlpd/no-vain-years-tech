// 本地 JPush config plugin（替代社区 jpush-expo-config-plugin@0.0.6）。
//
// 替换原因（2026-06-07 真机 logcat 实证）：社区插件给 JNotifyActivity 注入
// 2.8.3 时代的 android:theme="@android:style/Theme.Translucent.NoTitleBar" 并以
// tools:node="replace" 覆盖 AAR 自带声明；jpush 6.1.0 校验要求 @style/JPushTheme，
// 校验失败 → SDK drop 全部推送动作（注册正常但永远收不到通知）。
// AAR（cn.jiguang.sdk:jpush:6.1.0）内部 manifest 已自带正确的 JNotifyActivity
// 声明，merge 即可，无需注入 —— 本插件只保留必要三件事：
//   1. AndroidManifest meta-data JPUSH_APPKEY / JPUSH_CHANNEL（placeholder 引用）
//   2. app/build.gradle manifestPlaceholders
//   3. settings.gradle / dependencies 显式链接 jpush & jcore
// iOS 侧不做任何事（社区插件的 AppDelegate 注入只支持 ObjC，SDK 54 已是 Swift；
// iOS 接入留给 021 正式实现）。
const {
  AndroidConfig,
  withAppBuildGradle,
  withSettingsGradle,
  withAndroidManifest,
  withMainApplication,
} = require('@expo/config-plugins');

const withJPush = (config, props) => {
  if (!props || !props.appKey || !props.channel) {
    throw new Error('[with-jpush] 请传入参数 appKey & channel');
  }
  const { appKey, channel } = props;

  config = withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application[0];
    if (AndroidConfig.Manifest.findMetaDataItem(app, 'JPUSH_APPKEY') === -1) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(
        app,
        'JPUSH_APPKEY',
        '${JPUSH_APPKEY}',
      );
    }
    if (AndroidConfig.Manifest.findMetaDataItem(app, 'JPUSH_CHANNEL') === -1) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(
        app,
        'JPUSH_CHANNEL',
        '${JPUSH_CHANNEL}',
      );
    }
    return config;
  });

  config = withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;
    if (!contents.includes('JPUSH_APPKEY')) {
      contents = contents.replace(
        /defaultConfig\s*\{/,
        `defaultConfig {\n        manifestPlaceholders = [\n            JPUSH_APPKEY: "${appKey}",\n            JPUSH_CHANNEL: "${channel}"\n        ]`,
      );
    }
    if (!contents.includes(`implementation project(':jpush-react-native')`)) {
      contents = contents.replace(
        /dependencies\s*\{/,
        // jcore SDK 直引：wrapper build.gradle 用 implementation 引 SDK 不传递,
        // MainApplication.kt 的 JCollectionAuth(在 jcore)注入需要 app module 可见
        // 该类(版本与 jcore-react-native 2.3.6 内 pin 的 5.4.0 同步,升 wrapper 时同改)。
        `dependencies {\n    implementation project(':jpush-react-native')\n    implementation project(':jcore-react-native')\n    implementation "cn.jiguang.sdk:jcore:5.4.0"`,
      );
    }
    config.modResults.contents = contents;
    return config;
  });

  // 隐私合规前置闸（FR-001/SC-004，2026-06-07 真机 logcat 实证）：JPush/JCore AAR
  // 在 MainActivity 创建时 native 自启（JS 一行 SDK 接口未调即注册 Action + 起
  // JCoreModuleService + 发 DNS）——JS 层 consent gate 管不到。官方修法 = 进程
  // 启动即 JCollectionAuth.setAuth(false) 压住；同意后 JS 路径 JPush.init() 自动
  // 放行（JCore ≥5.0.4 init 自带授权，无需 setAuth(true)，docs.jiguang.cn/jpush/
  // practice/compliance）。每次启动都先压——已同意场景由 ConsentGate 放行后的
  // init 立即恢复，未同意场景保持静默。
  // 类在 JCore 不在 JPush（官方文档 import 是旧版布局）：javap 实证
  // jcore-android-5.4.0.jar → cn.jiguang.api.utils.JCollectionAuth.setAuth(Context,boolean)。
  config = withMainApplication(config, (config) => {
    let contents = config.modResults.contents;
    if (!contents.includes('JCollectionAuth.setAuth')) {
      contents = contents.replace(
        /super\.onCreate\(\)/,
        `super.onCreate()\n    cn.jiguang.api.utils.JCollectionAuth.setAuth(this, false)`,
      );
    }
    config.modResults.contents = contents;
    return config;
  });

  config = withSettingsGradle(config, (config) => {
    if (!config.modResults.contents.includes(`include ':jpush-react-native'`)) {
      config.modResults.contents += `
include ':jpush-react-native'
project(':jpush-react-native').projectDir = new File(rootProject.projectDir, '../node_modules/jpush-react-native/android')
include ':jcore-react-native'
project(':jcore-react-native').projectDir = new File(rootProject.projectDir, '../node_modules/jcore-react-native/android')
`;
    }
    return config;
  });

  return config;
};

module.exports = withJPush;
