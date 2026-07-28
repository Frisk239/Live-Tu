import { ProductItem } from '../types';

export const BUV_BRAND_INFO = {
  name: 'BUV 笔薇 小绿泥洁面',
  positioning: '油皮专研 · 温和净澈 · 植萃控油',
  price: '49元/100g',
  salesRecord: '连续2年沙利文【国货控油洁面销量第一】 / 全网已售 3000万支 / 央视推荐',
  model343: {
    clays: '3重天然泥：亚马逊白泥（深层吸附） + 摩洛哥火山泥（油脂微孔） + 曼尼古根冰河泥（矿物修护）',
    extracts: '4重控油植萃：叶绿素（调节微生态） + 白柳树皮（水杨酸温和收敛） + 药用层孔菌（紧致毛孔） + 积雪草（舒缓退红）',
    surfactants: '3重清洁表活：氨基酸（温和） + 甜菜碱（保湿） + 脂肪酸（强效净澈力）',
  },
  sgsData: {
    oil8h: '8小时控油 -66.87%',
    oil14d: '14天出油 -35.28%',
    blackhead14d: '14天黑头 -35.92%',
  },
  prohibitedWords: ['震惊！', '必看！', '第一名！', '绝对效用', '医用级治愈'],
};

export const PRODUCT_TEMPLATES: Partial<ProductItem>[] = [
  {
    name: '洁面/卸妆类产品模板',
    category: '洁面护肤',
    positioning: '温和深洁 · 水油平衡 · 毛孔通透',
    price: '59元/120g',
    salesRecord: '爆款实测认证 / 达人推荐',
    model343: {
      clays: '核心吸附成分：火山泥 / 竹炭 / 高岭土',
      extracts: '控油舒缓植萃：茶树 / 积雪草 / 金缕梅',
      surfactants: '温和清洁体系：氨基酸 / 甜菜碱 / 椰油酰基',
    },
    sgsData: {
      oil8h: '即刻控油 -50%',
      oil14d: '14天毛孔细腻 +20%',
      blackhead14d: '14天黑头减少 -30%',
    },
    prohibitedWords: ['绝对不紧绷', '彻底除黑头', '100%无刺激'],
    targetAudience: '油皮及混油皮人群',
    customSellingPoints: '泡沫丰盈绵密，易冲洗无残留，洗完水润哑光。',
  },
  {
    name: '精华/面霜类产品模板',
    category: '精华修护',
    positioning: '修护屏障 · 弹润紧致 · 高效吸收',
    price: '159元/50ml',
    salesRecord: '热销口碑好评 / 权威实验室功效背书',
    model343: {
      clays: '高活性修护因子：胜肽 / 玻色因 / 酵母滤液',
      extracts: '植萃复配：积雪草 / 依克多因 / 植萃角鲨烷',
      surfactants: '促透锁水网膜：神经酰胺 / 玻尿酸微囊',
    },
    sgsData: {
      oil8h: '24小时深度保湿',
      oil14d: '14天退红舒缓 -35%',
      blackhead14d: '28天细纹淡化 -22%',
    },
    prohibitedWords: ['即刻逆龄', '永不长皱纹', '替代医美'],
    targetAudience: '初老肌、干燥受损肌、熬夜暗沉肌',
    customSellingPoints: '润而不腻，触肤即融，建立皮肤天然防护屏障。',
  },
  {
    name: '洗护/控油类产品模板',
    category: '洗护控油',
    positioning: '头皮护理 · 蓬松丰盈 · 清爽止痒',
    price: '79元/500ml',
    salesRecord: '高回购率控油洗发水',
    model343: {
      clays: '发根强韧成分：咖啡因 / 生姜复合物',
      extracts: '头皮微生态调节：迷迭香 / 侧柏叶 / 水杨酸',
      surfactants: '无硅油温和表活：APG / 氨基酸清洁',
    },
    sgsData: {
      oil8h: '72小时控油蓬松',
      oil14d: '14天头皮油脂 -40%',
      blackhead14d: '14天发丝丰盈度 +35%',
    },
    prohibitedWords: ['生发100%', '永久不掉发', '无患子洗尽'],
    targetAudience: '发根扁塌、头皮易出油发痒人群',
    customSellingPoints: '持久留香，洗后发根自然蓬松有空气感。',
  },
  {
    name: '自定义空白产品',
    category: '自由定制',
    positioning: '自定义定位描述...',
    price: '99元',
    salesRecord: '填写销量或热销纪录...',
    model343: {
      clays: '主要功效成分 1',
      extracts: '辅助调理成分 2',
      surfactants: '基础配方体系 3',
    },
    sgsData: {
      oil8h: '功效指标 1',
      oil14d: '功效指标 2',
      blackhead14d: '功效指标 3',
    },
    prohibitedWords: ['震惊！', '必看！'],
    targetAudience: '目标受众人群描述...',
    customSellingPoints: '请输入特色卖点描述...',
  },
];
