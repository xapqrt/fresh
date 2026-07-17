#![no_std]

use libm::sqrtf;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

fn read_f32(ptr: *const f32, off: usize) -> f32 {
    unsafe { *ptr.add(off) }
}

#[no_mangle]
pub unsafe extern "C" fn parse_sig(offset: i32) -> i32 {
    let ptr = offset as *const f32;
    let a0 = read_f32(ptr, 0);
    let a1 = read_f32(ptr, 1);
    let a2 = read_f32(ptr, 2);
    let b0 = read_f32(ptr, 4);
    let b1 = read_f32(ptr, 5);
    let b2 = read_f32(ptr, 6);
    let c0 = read_f32(ptr, 8);
    let c1 = read_f32(ptr, 9);
    let c2 = read_f32(ptr, 10);

    let ma = sqrtf(a0 * a0 + a1 * a1 + a2 * a2);
    let mb = sqrtf(b0 * b0 + b1 * b1 + b2 * b2);
    let mc = sqrtf(c0 * c0 + c1 * c1 + c2 * c2);

    ((ma * 100.0 + 0.5) as i32) << 20
        | ((mb * 100.0 + 0.5) as i32) << 10
        | (mc * 100.0 + 0.5) as i32
}

#[no_mangle]
pub unsafe extern "C" fn fast_hash(offset: i32) -> i32 {
    let ptr = offset as *const f32;
    let idx = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14];
    let mut h = (read_f32(ptr, idx[0]) as i32) * 100;
    let mut k = 1;
    while k < 12 {
        let v = (read_f32(ptr, idx[k]) as i32) * 100;
        h = h.wrapping_mul(31).wrapping_add(v);
        k += 1;
    }
    h
}
