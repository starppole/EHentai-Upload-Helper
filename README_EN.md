<img width="1258" height="786" alt="PPin20260521 231551" src="https://github.com/user-attachments/assets/6801fdc7-e9f1-48b3-b65b-fc31d34dc535" />


[中文](./README.md) | [English](./README_EN.md)

# What is this

An ehentai automatic upload organization and grouping helper that simplifies repetitive operations, with basic image compression support included (GIF format is not supported).

## Why use this

2.1.If you use the original upload function, you will face the limitation (“The total size of one upload should not exceed 500 MB”). However, image originals are becoming larger and larger nowadays. When a single image can already reach 20~30 MB, uploading only 10 images at a time and waiting repeatedly dozens of times in a gallery containing hundreds of images starts to feel pretty antihuman.

2.2 If you upload 100 images at once and wait until the upload progress bar reaches 99%, but the last image exceeds the official size or resolution limit (“Images: JPG and WebP < 20 MB, PNG < 50 MB, GIF < 10 MB; Archives: ZIP. Maximum resolution: 20000 x 20000.”), bang! All the upload time and waiting you spent will be completely wasted.

## What can it do

3.1.Select all the images/ZIP files you want to upload at once. The script will analyze file sizes, group them automatically, and continuously upload them without interruption, requiring no further manual operation.

3.2.Analyze image sizes, automatically compress files exceeding the official limit, and return them to the queue.

## How to use

Install Tampermonkey as a prerequisite, create a new userscript, paste the code, save it, and refresh the eh upload page to make it work.

## Details

### About image compression:

1. First read the original image dimensions.
2. If width or height exceeds 20000 × 20000, resize it within the limit first.
3. If the total pixel count exceeds `80 million pixels`, it will also be resized first to prevent Canvas memory overflow.
4. Output format is fixed to: image/webp

5.In each round, dimensions are kept unchanged first, and only quality is reduced: 0.92, 0.86, 0.80, 0.74, 0.68, 0.62, 0.56, 0.50, 0.44, 0.38

6.If the lowest quality 0.38 in the current round is still larger than the target size, width and height will be multiplied by 0.85, then compression restarts again from quality 0.92.

7.Maximum of 10 rounds.

8.After success, the filename becomes: original_filename_compressed.webp

9.If the target size still cannot be reached after 10 rounds, it reports: Compression still exceeds the limit after processing.

### Persistent queue description

The persistent queue is used to solve the issue where the page refreshes after upload completion.

Normal File objects selected through `<input type="file">` only exist in the current page memory.  
After refreshing the page, the browser clears these File objects, and the script can no longer access previously selected files.

The persistent queue uses the File System Access API to save file handles.  
After refreshing, the script re-reads local files through the file handles:

```js
const file = await handle.getFile();
```
This method does not copy the actual file data into IndexedDB, nor does it additionally store several GB of images or ZIP files.
