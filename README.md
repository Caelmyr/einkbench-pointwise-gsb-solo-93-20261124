# EInkBench

EInkBench reviews camera photos of a display cleared to white after different refresh tests. Start with the labeled synthetic practice sequence or bring your settled white reference and one or more refresh captures.

```sh
./start.sh
```

Open http://127.0.0.1:19896/. Docker Compose keeps your batches in a dedicated named volume. Use `./start.sh stop` to stop the service and `INKBENCH_PORT` to pick another localhost port.

1. Import the settled white photo. Under Capture, add each photo with its previous pattern, elapsed milliseconds and trial number. Use a fixed camera and equal pixel dimensions.
2. Select an active capture and switch between its original, the reference and the signed residual map. Use **Add zone** and click two opposite corners. Use **Probe pixel** to read the original RGB values, original coordinates and signed luminance difference.
3. To separate checker ghosting from a stain that is simply dark in the white photos, choose the two captures made after opposite previous patterns under **Opposite pair** and switch to the **Opposite pair** view. A square kept there is darker than white in one photo and brighter in the other at the same pixel; a dark patch present in both photos is left blank, as is any place that only differs by blank noise. Faint stretches of a square edge are retained when the other photo still reads, isolated dots are not. **Probe pixel** in this view reads the same pixel in both originals against white.
4. Read signed mean, absolute 95th percentile and the areas above the threshold in both directions. The plot tracks absolute P95 by previous pattern, trial and zone. Click a wait entry to inspect its capture.
5. Set the preferred wait for the next capture and save the setup. Save a report to retain the inputs and measurement settings at that time. Open a report to download its CSV, residual map and the selected original capture.
6. Open the photo preparation workspace to align or clean a separate photo set, then use its result to start a new reference batch. The prepared result's source record stays with the reference.

A single image can contain up to four million pixels with sides from 8 to 4096 pixels. Import accepts opaque single-frame PNG and JPEG files up to 14 MiB and records the EXIF-oriented image. Each batch holds up to sixteen captures and eight zones. The camera-space residual assumes equal crop, alignment, exposure and illumination across the batch. Its DN measurements use 8-bit display luminance values. The practice sequence is generated and labeled synthetic. It illustrates the workflow without representing the performance of a physical display.
