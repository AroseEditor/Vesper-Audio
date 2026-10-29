use super::*;
use windows::core::GUID;
use windows::Devices::Bluetooth::BluetoothAdapter;
use windows::Devices::Bluetooth::Rfcomm::{RfcommServiceId, RfcommServiceProvider};
use windows::Foundation::TypedEventHandler;
use windows::Networking::Sockets::{SocketProtectionLevel, StreamSocket, StreamSocketListener, StreamSocketListenerConnectionReceivedEventArgs};
use windows::Storage::Streams::{DataReader, DataWriter};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

pub const SERVICE_UUID: u128 = 0x7ae1b6a0_5f6d_4a8e_9c3a_5e5a56455350;

fn read_frame(reader: &DataReader) -> windows::core::Result<Option<Value>> {
    if reader.LoadAsync(4)?.join()? < 4 {
        return Ok(None);
    }
    let length = reader.ReadUInt32()? as usize;
    if length == 0 || length > proto::MAX_FRAME {
        return Ok(None);
    }
    if reader.LoadAsync(length as u32)?.join()? as usize != length {
        return Ok(None);
    }
    let mut bytes = vec![0u8; length];
    reader.ReadBytes(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes).ok())
}

fn write_value(writer: &DataWriter, value: &Value) -> windows::core::Result<()> {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    writer.WriteUInt32(bytes.len() as u32)?;
    writer.WriteBytes(&bytes)?;
    writer.StoreAsync()?.join()?;
    Ok(())
}

fn handle(link: Link, socket: StreamSocket) -> windows::core::Result<()> {
    let reader = DataReader::CreateDataReader(&socket.InputStream()?)?;
    let writer = DataWriter::CreateDataWriter(&socket.OutputStream()?)?;
    for _ in 0..8 {
        let message = match read_frame(&reader)? {
            Some(m) => m,
            None => break,
        };
        if let Some(reply) = link.bluetooth_message(&message) {
            write_value(&writer, &reply)?;
        }
    }
    Ok(())
}

fn serve(link: Link, announce: std::sync::mpsc::Sender<Option<String>>) -> windows::core::Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let adapter = BluetoothAdapter::GetDefaultAsync()?.join()?;
    let address = adapter.BluetoothAddress()?;
    let provider = RfcommServiceProvider::CreateAsync(&RfcommServiceId::FromUuid(GUID::from_u128(SERVICE_UUID))?)?.join()?;
    let listener = StreamSocketListener::new()?;
    let accepting = link.clone();
    listener.ConnectionReceived(&TypedEventHandler::<StreamSocketListener, StreamSocketListenerConnectionReceivedEventArgs>::new(move |_, args| {
        if let Some(args) = args.as_ref() {
            let socket = args.Socket()?;
            let worker = accepting.clone();
            thread::spawn(move || {
                let _ = handle(worker, socket);
            });
        }
        Ok(())
    }))?;
    listener.BindServiceNameWithProtectionLevelAsync(&provider.ServiceId()?.AsString()?, SocketProtectionLevel::PlainSocket)?.join()?;
    if provider.StartAdvertisingWithRadioDiscoverability(&listener, true).is_err() {
        provider.StartAdvertising(&listener)?;
    }
    let mac = format!("{:012X}", address);
    let _ = announce.send(Some(mac));
    while !link.is_stopped() {
        thread::sleep(Duration::from_millis(500));
    }
    provider.StopAdvertising()?;
    Ok(())
}

pub fn start(link: Link) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let tx_failed = tx.clone();
    thread::spawn(move || {
        if serve(link, tx).is_err() {
            let _ = tx_failed.send(None);
        }
    });
    rx.recv_timeout(Duration::from_secs(6)).ok().flatten()
}
