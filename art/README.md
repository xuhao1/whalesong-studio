# Art

The whale maid on the Studio's home page, as she was drawn — the full-size pictures the small copies in `src/client/art/` are made from. Not shipped with the package.

| File | Where it is used |
|---|---|
| `home-hero.webp` | the banner of the home page (cropped to her and the shelf behind her) |
| `home-create.webp` | the head of the *New work* page |
| `home-empty.webp` | the shelf with no book on it |

Drawn on 2026-10-08 with `qwen-image-3.0` (Aliyun Bailian), with the project's own icon art (`icon.png`, `docs/images/icon-alt.webp`) given as reference pictures so that she is the same figure. The figure follows the DeepSeek community's whale maid, DeepSeek-chan: 溟月 by 上善无形, in the DeepSeek maid design by ZipZipPipe.

`home-create.webp` was drawn again on 2026-10-10: the same picture handed back as the reference, with one thing asked — her tail made small, as it is in the other two (it stood taller than she did).

To make the copies the Studio ships:

```bash
cwebp -q 84 -crop 660 0 876 1024 -resize 0 600 hero.png -o src/client/art/home-hero.webp
cwebp -q 84 -resize 440 440 create.png -o src/client/art/home-create.webp
cwebp -q 84 -resize 440 440 empty.png -o src/client/art/home-empty.webp
```
