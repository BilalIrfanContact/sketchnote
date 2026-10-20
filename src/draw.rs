//! Keyframe images: burning marks in, cropping to the activity, the contact sheet.

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use image::{RgbaImage, imageops};
use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, PremultipliedColorU8, Stroke, Transform,
};

use crate::capture::{Kind, Mark, Rect};

const RED: [u8; 3] = [255, 48, 48];
const BLUE: [u8; 3] = [64, 140, 255];
const WHITE: [u8; 3] = [255, 255, 255];
const BADGE: [u8; 3] = [24, 24, 27];
const SHEET_BG: [u8; 3] = [17, 17, 19];
pub const COLUMN_WIDTH: u32 = 720;
pub const GAP: u32 = 16;
/// Logical px of context around a mark's activity.
const PAD: f64 = 160.0;
/// Logical px; small marks still get readable context.
const MIN_CROP: (f64, f64) = (640.0, 400.0);

static FONT: &[u8] = include_bytes!("../assets/DejaVuSans-Bold.ttf");

/// Maps stage coordinates to pixels of the recording (handles area offset + scale).
pub struct Mapper {
    area: Rect,
    sx: f64,
    sy: f64,
}

impl Mapper {
    pub fn new(area: Rect, video_size: (u32, u32)) -> Self {
        Mapper { area, sx: video_size.0 as f64 / area[2], sy: video_size.1 as f64 / area[3] }
    }

    pub fn px(&self, x: f64, y: f64) -> (f64, f64) {
        ((x - self.area[0]) * self.sx, (y - self.area[1]) * self.sy)
    }
}

/// Draws a mark's stroke, click ring or numbered pin onto its keyframe.
pub fn draw_mark(img: &mut RgbaImage, mark: &Mark, map: &Mapper) {
    let scale = map.sx as f32;
    let width = (3.0 * scale).round().max(2.0);
    let e = &mark.event;
    with_pixmap(img, |pm| match e.kind {
        Kind::Stroke if e.points.len() > 1 => {
            let mut pb = PathBuilder::new();
            for (i, p) in e.points.iter().enumerate() {
                let (x, y) = map.px(p[0], p[1]);
                if i == 0 { pb.move_to(x as f32, y as f32) } else { pb.line_to(x as f32, y as f32) }
            }
            stroke_path(pm, pb, RED, width);
        }
        Kind::Click | Kind::Pin => {
            let Some(&[x, y]) = e.spots().first() else { return };
            let (x, y) = map.px(x, y);
            let (x, y) = (x as f32, y as f32);
            if e.kind == Kind::Click {
                stroke_path(pm, circle(x, y, 14.0 * scale), BLUE, width);
            } else {
                fill_path(pm, circle(x, y, 13.0 * scale), RED);
                text_centered(pm, &mark.n.to_string(), x, y, (15.0 * scale).round(), WHITE);
            }
        }
        _ => {}
    });
}

/// Box (x0, y0, x1, y1) in recording pixels around the mark's activity: padded,
/// grown to a readable minimum, clamped to the mark's window and the recording.
pub fn crop_box(mark: &Mark, area: Rect, map: &Mapper, video_size: (u32, u32)) -> (u32, u32, u32, u32) {
    let (w, h) = video_size;
    let e = &mark.event;
    let pts = e.spots();
    if e.kind == Kind::None || pts.is_empty() {
        return (0, 0, w, h);
    }
    let xs = pts.iter().map(|p| p[0]);
    let ys = pts.iter().map(|p| p[1]);
    let (x0, x1) = grow(xs.clone().fold(f64::MAX, f64::min) - PAD, xs.fold(f64::MIN, f64::max) + PAD, MIN_CROP.0);
    let (y0, y1) = grow(ys.clone().fold(f64::MAX, f64::min) - PAD, ys.fold(f64::MIN, f64::max) + PAD, MIN_CROP.1);
    let mut b = [area[0], area[1], area[0] + area[2], area[1] + area[3]];
    if let Some([wx, wy, ww, wh]) = e.window.as_ref().and_then(|w| w.rect) {
        b = [b[0].max(wx), b[1].max(wy), b[2].min(wx + ww), b[3].min(wy + wh)];
    }
    let (mut x0, mut y0, mut x1, mut y1) = (x0.max(b[0]), y0.max(b[1]), x1.min(b[2]), y1.min(b[3]));
    if x1 - x0 < 8.0 || y1 - y0 < 8.0 {
        // Activity outside its window/area: use the area.
        (x0, y0, x1, y1) = (area[0], area[1], area[0] + area[2], area[1] + area[3]);
    }
    let (px0, py0) = map.px(x0, y0);
    let (px1, py1) = map.px(x1, y1);
    let clamp = |v: f64, max: u32| (v.round().max(0.0) as u32).min(max);
    (clamp(px0, w), clamp(py0, h), clamp(px1, w), clamp(py1, h))
}

fn grow(a: f64, b: f64, size: f64) -> (f64, f64) {
    if b - a >= size {
        return (a, b);
    }
    let mid = (a + b) / 2.0;
    (mid - size / 2.0, mid + size / 2.0)
}

/// Two-column masonry of `(number, tile)`: each tile goes into the shorter column
/// and gets a number badge in its top-right corner.
pub fn contact_sheet(tiles: &[(usize, RgbaImage)]) -> RgbaImage {
    let mut cols = [GAP, GAP];
    let mut placed = vec![];
    for (n, tile) in tiles {
        let th = ((tile.height() as f64 * COLUMN_WIDTH as f64 / tile.width() as f64).round() as u32).max(1);
        let c = if cols[0] <= cols[1] { 0 } else { 1 };
        let resized = imageops::resize(tile, COLUMN_WIDTH, th, imageops::FilterType::Lanczos3);
        placed.push((*n, resized, GAP + c as u32 * (COLUMN_WIDTH + GAP), cols[c]));
        cols[c] += th + GAP;
    }
    let ncols = if tiles.len() > 1 { 2 } else { 1 };
    let [r, g, b] = SHEET_BG;
    let mut sheet =
        RgbaImage::from_pixel(GAP + ncols * (COLUMN_WIDTH + GAP), cols[0].max(cols[1]), [r, g, b, 255].into());
    for (_, tile, x, y) in &placed {
        imageops::replace(&mut sheet, tile, *x as i64, *y as i64);
    }
    with_pixmap(&mut sheet, |pm| {
        for (n, _, x, y) in &placed {
            let (cx, cy) = ((x + COLUMN_WIDTH - 22) as f32, (y + 22) as f32);
            fill_path(pm, circle(cx, cy, 14.0), BADGE);
            stroke_path(pm, circle(cx, cy, 14.0), WHITE, 2.0);
            text_centered(pm, &n.to_string(), cx, cy, 17.0, WHITE);
        }
    });
    sheet
}

// --- drawing helpers ----------------------------------------------------------

/// Lets tiny-skia draw on an opaque image (opaque pixels are the same premultiplied).
fn with_pixmap(img: &mut RgbaImage, draw: impl FnOnce(&mut Pixmap)) {
    let (w, h) = img.dimensions();
    let data = std::mem::take(img).into_raw();
    let mut pm = Pixmap::from_vec(data, tiny_skia::IntSize::from_wh(w, h).unwrap()).unwrap();
    draw(&mut pm);
    *img = RgbaImage::from_raw(w, h, pm.take()).unwrap();
}

fn paint([r, g, b]: [u8; 3]) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(Color::from_rgba8(r, g, b, 255));
    p.anti_alias = true;
    p
}

fn circle(x: f32, y: f32, r: f32) -> PathBuilder {
    let mut pb = PathBuilder::new();
    pb.push_circle(x, y, r);
    pb
}

fn stroke_path(pm: &mut Pixmap, pb: PathBuilder, color: [u8; 3], width: f32) {
    let Some(path) = pb.finish() else { return };
    let stroke = Stroke { width, line_cap: LineCap::Round, line_join: LineJoin::Round, ..Stroke::default() };
    pm.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
}

fn fill_path(pm: &mut Pixmap, pb: PathBuilder, color: [u8; 3]) {
    let Some(path) = pb.finish() else { return };
    pm.fill_path(&path, &paint(color), FillRule::Winding, Transform::identity(), None);
}

/// Draws `text` centred on (cx, cy), vertically between ascender and descender.
fn text_centered(pm: &mut Pixmap, text: &str, cx: f32, cy: f32, size: f32, color: [u8; 3]) {
    let font = FontRef::try_from_slice(FONT).expect("bundled font");
    let sf = font.as_scaled(PxScale::from(size));
    let width: f32 = text.chars().map(|c| sf.h_advance(sf.glyph_id(c))).sum();
    let baseline = cy + (sf.ascent() + sf.descent()) / 2.0;
    let mut x = cx - width / 2.0;
    let (pw, ph) = (pm.width() as i32, pm.height() as i32);
    for c in text.chars() {
        let glyph = sf.glyph_id(c).with_scale_and_position(size, ab_glyph::point(x, baseline));
        x += sf.h_advance(glyph.id);
        let Some(outline) = font.outline_glyph(glyph) else { continue };
        let bounds = outline.px_bounds();
        let pixels = pm.pixels_mut();
        outline.draw(|gx, gy, coverage| {
            let (px, py) = (bounds.min.x as i32 + gx as i32, bounds.min.y as i32 + gy as i32);
            if px < 0 || py < 0 || px >= pw || py >= ph {
                return;
            }
            let p = &mut pixels[(py * pw + px) as usize];
            let a = coverage.clamp(0.0, 1.0);
            let mix = |dst: u8, src: u8| (dst as f32 * (1.0 - a) + src as f32 * a).round() as u8;
            *p = PremultipliedColorU8::from_rgba(
                mix(p.red(), color[0]),
                mix(p.green(), color[1]),
                mix(p.blue(), color[2]),
                255,
            )
            .unwrap();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{Event, Window};

    fn mark(event: Event) -> Mark {
        Mark { n: 1, t: event.t, kind: event.kind.clone(), frame_t: 0.0, event, text: String::new() }
    }

    #[test]
    fn mapper_handles_area_offset_and_scale() {
        let map = Mapper::new([100.0, 50.0, 400.0, 300.0], (800, 600));
        assert_eq!(map.px(100.0, 50.0), (0.0, 0.0));
        assert_eq!(map.px(300.0, 200.0), (400.0, 300.0));
    }

    #[test]
    fn crop_is_padded_and_clamped_to_window() {
        let area = [0.0, 0.0, 1920.0, 1080.0];
        let window = Window { app: "a".into(), title: "t".into(), rect: Some([0.0, 0.0, 1000.0, 700.0]) };
        let e = Event {
            t: 0.0,
            kind: Kind::Click,
            t_end: None,
            frame_t: None,
            points: vec![],
            x: Some(50.0),
            y: Some(50.0),
            window: Some(window),
        };
        let map = Mapper::new(area, (1920, 1080));
        // Min size 640x400 centred on the click, clamped at 0.
        assert_eq!(crop_box(&mark(e), area, &map, (1920, 1080)), (0, 0, 370, 250));
    }

    #[test]
    fn contact_sheet_two_columns() {
        let tiles: Vec<_> = (1..=3).map(|i| (i, RgbaImage::new(100, 50 * i as u32))).collect();
        assert_eq!(contact_sheet(&tiles).width(), GAP + 2 * (COLUMN_WIDTH + GAP));
    }
}
