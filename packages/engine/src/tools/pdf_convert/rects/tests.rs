//! Tests for the `pdfImageRects` port (see `super`).

use super::*;

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

#[test]
fn ctm_simulation_places_unit_square() {
    let mut names = HashSet::new();
    names.insert("Im1".to_owned());
    let content = b"q 100 0 0 50 10 20 cm /Im1 Do Q 5 0 0 5 0 0 cm /Other Do";
    assert_eq!(
        collect_placed_rects(&names, content),
        vec![rect(10.0, 20.0, 100.0, 50.0)]
    );
}

#[test]
fn tokenizer_skips_strings_comments_and_brackets() {
    let mut names = HashSet::new();
    names.insert("Im".to_owned());
    // The hex-string token clears the operand run like any other
    // non-numeric token, so it sits between `cm` and its `/Im`.
    let content = b"% note\nq (te(st)\\) x) [/Im] 20 0 0 30 1 1 cm <a1> /Im Do Q";
    assert_eq!(
        collect_placed_rects(&names, content),
        vec![rect(1.0, 1.0, 20.0, 30.0)]
    );
}

#[test]
fn small_and_negative_rects_are_normalized_and_filtered() {
    let mut names = HashSet::new();
    names.insert("Im".to_owned());
    let content = b"q 20 0 0 20 1 1 cm /Im Do Q \
q -100 0 0 -50 30 40 cm /Im Do Q \
10 0 0 10 0 0 cm /Im Do";
    assert_eq!(
        collect_placed_rects(&names, content),
        vec![rect(1.0, 1.0, 20.0, 20.0), rect(-70.0, -10.0, 100.0, 50.0)]
    );
}

#[test]
fn visual_rect_rotations_match_ts() {
    let r = rect(10.0, 20.0, 100.0, 50.0);
    assert_eq!(to_visual_rect(r, 612.0, 792.0, 0), rect(10.0, 722.0, 100.0, 50.0));
    assert_eq!(to_visual_rect(r, 612.0, 792.0, 90), rect(20.0, 502.0, 50.0, 100.0));
    assert_eq!(to_visual_rect(r, 612.0, 792.0, 180), rect(502.0, 722.0, 100.0, 50.0));
    assert_eq!(to_visual_rect(r, 612.0, 792.0, 270), rect(722.0, 10.0, 50.0, 100.0));
}

#[test]
fn nested_q_restores_matrices() {
    let mut names = HashSet::new();
    names.insert("Im".to_owned());
    // Chained `cm` multiplies (30*70), so restoring needs `Q` between.
    let content = b"q 30 0 0 30 0 0 cm /Im Do Q q 70 0 0 70 0 0 cm /Im Do Q";
    assert_eq!(
        collect_placed_rects(&names, content),
        vec![rect(0.0, 0.0, 30.0, 30.0), rect(0.0, 0.0, 70.0, 70.0)]
    );
}

/// Builds a minimal one-page PDF (content uncompressed, like the TS fixture
/// path) whose page draws /Im0 through the given content stream.
fn one_page_pdf(content: &[u8], rotation: Option<i64>) -> Vec<u8> {
    use lopdf::{dictionary, Dictionary, Object, Stream};
    let mut document = Document::with_version("1.7");
    let pages_id = document.add_object(Object::Dictionary(dictionary! {
        "Type" => "Pages",
        "Kids" => Object::Array(Vec::new()),
        "Count" => Object::Integer(0),
    }));
    let catalog_id = document.add_object(Object::Dictionary(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    }));
    document.trailer.set("Root", Object::Reference(catalog_id));
    let image_id = document.add_object(Object::Stream(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image",
            "Width" => 4, "Height" => 4,
            "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        },
        vec![128u8; 48],
    )));
    let mask_id = document.add_object(Object::Stream(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "ImageMask" => true,
            "Width" => 4, "Height" => 4, "BitsPerComponent" => 1,
        },
        vec![0u8; 4],
    )));
    let content_id = document.add_object(Stream::new(Dictionary::new(), content.to_vec()));
    let mut page = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(200),
            Object::Integer(400),
        ]),
        "Resources" => Object::Dictionary(dictionary! {
            "XObject" => Object::Dictionary(dictionary! {
                "Im0" => Object::Reference(image_id),
                "Mask" => Object::Reference(mask_id),
            }),
        }),
        "Contents" => Object::Reference(content_id),
    };
    if let Some(angle) = rotation {
        page.set("Rotate", Object::Integer(angle));
    }
    let page_id = document.add_object(Object::Dictionary(page));
    if let Some(Object::Dictionary(pages)) = document.objects.get_mut(&pages_id) {
        pages.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
        pages.set("Count", Object::Integer(1));
    }
    let mut output = std::io::Cursor::new(Vec::new());
    document.save_to(&mut output).unwrap();
    output.into_inner()
}

#[test]
fn full_document_export_reads_placement_rotation_and_masks() {
    // /Mask is an image-mask XObject and must be skipped; the visual rect of
    // the 100x50 draw on a 200x400 page flips to top-left origin space.
    let bytes = one_page_pdf(b"q 100 0 0 50 10 20 cm /Im0 Do /Mask Do Q", None);
    let document = pdf_image_rects_document(&bytes).unwrap();
    assert_eq!(document.pages.len(), 1);
    let page = &document.pages[0];
    assert_eq!(page.page, 1);
    assert_eq!(page.rotation, 0);
    assert_eq!((page.width, page.height), (200.0, 400.0));
    assert_eq!(page.rects, vec![[10.0, 330.0, 100.0, 50.0]]);

    // With /Rotate 90 the visual page is 400x200 and the rect rotates.
    let bytes = one_page_pdf(b"q 100 0 0 50 10 20 cm /Im0 Do Q", Some(90));
    let document = pdf_image_rects_document(&bytes).unwrap();
    let page = &document.pages[0];
    assert_eq!(page.rotation, 90);
    assert_eq!((page.width, page.height), (400.0, 200.0));
    assert_eq!(page.rects, vec![[20.0, 90.0, 50.0, 100.0]]);
}

#[test]
fn corrupt_bytes_reject_with_unreadable_file() {
    let error = match pdf_image_rects_document(b"not a pdf") {
        Err(error) => error,
        Ok(_) => panic!("corrupt bytes must not parse"),
    };
    assert_eq!(error.code, "unreadable_file");
}
