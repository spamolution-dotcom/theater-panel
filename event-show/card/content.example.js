// Copy to content.js and fill in. Each scene = one photo (photos/<name>.jpg) and 1-2 short paragraphs.
// pos is the photo's focus point (CSS object-position) so faces stay in frame.
window.CONTENT = {
  greeting: 'Dear <Name> · <Nickname>…',
  name: '<Name>',
  date: '<Weekday> · <D Month YYYY>',
  scenes: [
    { photo: 'hero', pos: '50% 30%', text: ['First paragraph of scene one.', 'Second paragraph (appears once the first has been read).'] },
    { photo: 'two', pos: '50% 30%', text: ['Scene two.', 'More.'] },
    { photo: 'three', pos: '50% 30%', text: ['Scene three. <em>Italic gold for a quote.</em>'] },
  ],
  hold: { seconds: 40, eyebrow: 'Tonight’s feature', title: 'Please take your seat.', sub: 'The show begins shortly' },
  // Five photos: slot 3 (middle) is landscape, the others portrait.
  finale: { photos: ['two', 'three', 'group', 'hero', 'two'], pos: ['50% 30%', '50% 30%', '50% 40%', '50% 30%', '50% 30%'], wish: 'A closing line.', title: 'Happy Birthday!', sign: 'Love, <names>' },
};
