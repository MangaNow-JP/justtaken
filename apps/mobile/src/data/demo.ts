import type { ImageSourcePropType } from 'react-native';

export interface DemoPost {
  id: string;
  name: string;
  handle: string;
  initial: string;
  color: string;
  time: string;
  photo: ImageSourcePropType;
  description: string;
  caption: string;
  likes: number;
  comments: number;
  category: string;
}
export const demoPosts: DemoPost[] = [
  {
    id: 'sample-coffee',
    name: 'haru',
    handle: '@haru.days',
    initial: 'h',
    color: '#E9DCC8',
    time: '12分前',
    photo: require('../../assets/coffee.jpg'),
    description: 'アイスコーヒーのある、穏やかな午後のひととき',
    caption: '帰り道、ちょっと寄り道。\nこういう時間が、いちばん好き。',
    likes: 24,
    comments: 3,
    category: '日々のこと',
  },
  {
    id: 'sample-forest',
    name: 'sora',
    handle: '@sora.walks',
    initial: 's',
    color: '#DCE6CC',
    time: '28分前',
    photo: require('../../assets/forest.jpg'),
    description: '木漏れ日が差し込む緑の森',
    caption: 'いつもの散歩道にも、新しい光。',
    likes: 38,
    comments: 2,
    category: '散歩',
  },
  {
    id: 'sample-morning',
    name: 'nagi',
    handle: '@nagi.notes',
    initial: 'n',
    color: '#DEE4EB',
    time: '46分前',
    photo: require('../../assets/morning.jpg'),
    description: '霧がたなびく朝の緑の丘',
    caption: '早起きしてよかった。',
    likes: 52,
    comments: 4,
    category: '景色',
  },
];
